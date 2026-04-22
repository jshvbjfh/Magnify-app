import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { recordJournalEntry } from '@/lib/accounting'
import { consumeIngredientStock, InsufficientFifoStockError, InsufficientInventoryStockError } from '@/lib/inventoryConsumption'
import { enqueueSyncChange } from '@/lib/syncOutbox'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })
  const billingUserId = context?.billingUserId ?? session.user.id
  const restaurantId = context.restaurantId
  const branchId = context.branchId

  const logs = await prisma.wasteLog.findMany({
    where: {
      userId: billingUserId,
      restaurantId,
      branchId,
    },
    include: { ingredient: true },
    orderBy: { date: 'desc' }
  })
  return NextResponse.json(logs)
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const context = await getRestaurantContextForUser(session.user.id)
    if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })
    const billingUserId = context?.billingUserId ?? session.user.id
    const restaurantId = context.restaurantId
    const branchId = context.branchId

    const { ingredientId, quantityWasted, reason, notes, date } = await req.json()
    if (!ingredientId || !quantityWasted || !reason) {
      return NextResponse.json({ error: 'ingredientId, quantityWasted, reason required' }, { status: 400 })
    }

    const qty = Number(quantityWasted)
    if (!Number.isFinite(qty) || qty <= 0) {
      return NextResponse.json({ error: 'quantityWasted must be greater than 0' }, { status: 400 })
    }

    const entryDate = date ? new Date(date) : new Date()
    if (Number.isNaN(entryDate.getTime())) {
      return NextResponse.json({ error: 'Invalid date' }, { status: 400 })
    }

    const ingredient = await prisma.inventoryItem.findFirst({
      where: {
        id: ingredientId,
        userId: billingUserId,
        inventoryType: 'ingredient',
        restaurantId,
        branchId,
      },
      select: {
        id: true,
        name: true,
        unit: true,
        unitCost: true,
        quantity: true,
      },
    })
    if (!ingredient) return NextResponse.json({ error: 'Ingredient not found' }, { status: 404 })

    const logResult = await prisma.$transaction(async (tx) => {
      const createdLog = await tx.wasteLog.create({
        data: {
          userId: billingUserId,
          restaurantId,
          branchId,
          ingredientId,
          quantityWasted: qty,
          reason,
          notes: notes || null,
          date: entryDate,
          calculatedCost: 0,
        }
      })

      const consumption = await consumeIngredientStock(tx, {
        billingUserId,
        restaurantId,
        branchId,
        ingredientId,
        quantity: qty,
        fifoEnabled: true,
        sourceType: 'waste',
        sourceId: createdLog.id,
        consumedAt: entryDate,
        reason: `Waste: ${ingredient.name} - ${reason}`,
        ingredientSnapshot: ingredient,
      })

      await recordJournalEntry(tx, {
        userId: billingUserId,
        restaurantId,
        branchId,
        date: entryDate,
        description: `Waste: ${ingredient.name} - ${reason}`,
        amount: consumption.totalCost,
        direction: 'out',
        accountName: 'Waste & Spoilage',
        categoryType: 'expense',
        paymentMethod: 'Internal',
        counterAccountName: 'Inventory',
        counterCategoryType: 'asset',
        counterAccountType: 'asset',
        isManual: false,
        sourceKind: 'inventory_waste',
      })

      const finalizedLog = await tx.wasteLog.update({
        where: { id: createdLog.id },
        data: {
          calculatedCost: consumption.totalCost,
        },
      })

      await enqueueSyncChange(tx, {
        restaurantId,
        branchId,
        entityType: 'wasteLog',
        entityId: finalizedLog.id,
        operation: 'upsert',
        payload: finalizedLog,
      })

      return {
        log: finalizedLog,
        calculatedCost: consumption.totalCost,
      }
    }, { timeout: 30000 })

    return NextResponse.json(logResult, { status: 201 })
  } catch (error) {
    if (error instanceof InsufficientFifoStockError || error instanceof InsufficientInventoryStockError) {
      return NextResponse.json({
        error: error.message,
      code: error instanceof InsufficientFifoStockError ? 'FIFO_STOCK_SHORTAGE' : 'INVENTORY_STOCK_SHORTAGE',
        details: {
          ingredientId: error.ingredientId,
          ingredientName: error.ingredientName,
          requiredQuantity: error.requiredQuantity,
          availableQuantity: error.availableQuantity,
          unit: error.unit,
        },
      }, { status: 409 })
    }

    console.error('Failed to record waste:', error)
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to record waste' }, { status: 500 })
  }
}
