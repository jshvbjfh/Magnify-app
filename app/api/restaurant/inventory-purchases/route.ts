import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { recordJournalEntry } from '@/lib/accounting'
import { getActiveFifoUnitCost } from '@/lib/fifoCosting'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { enqueueSyncChange } from '@/lib/syncOutbox'
import { toUsageQuantity, toUsageUnitCost, normalizeUnitsPerPurchaseUnit } from '@/lib/inventoryUnits'
import type { Prisma } from '@prisma/client'

const PURCHASE_USAGE_EPSILON = 0.000001
const INVENTORY_TRANSACTION_OPTIONS = { maxWait: 15000, timeout: 60000 } as const

type ResolvedInventoryIngredient = {
  id: string
  name: string
  unit: string
  unitCost: number
  quantity: number
}

function normalizeInventoryItemName(name: string) {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

function sanitizeInventoryItemName(name: string) {
  return name.trim().replace(/\s+/g, ' ')
}

function formatInventoryNumber(value: number) {
  return Number(value || 0).toLocaleString('en-RW', { maximumFractionDigits: 3 })
}

function buildInventoryPurchaseDescription(params: {
  ingredientName: string
  ingredientUnit: string
  quantityPurchased: number
  supplier: string | null
}) {
  return `Purchase: ${params.ingredientName} (${formatInventoryNumber(params.quantityPurchased)} ${params.ingredientUnit}${params.supplier ? ` from ${params.supplier}` : ''})`
}

function hasConsumedPurchaseQuantity(purchase: { quantityPurchased: number; remainingQuantity: number }) {
  return purchase.quantityPurchased - purchase.remainingQuantity > PURCHASE_USAGE_EPSILON
}

async function resolveInventoryIngredient(
  tx: Prisma.TransactionClient,
  params: {
    restaurantId: string
    branchId: string
    ingredientId?: string | null
    itemName?: string | null
    unit?: string | null
    unitCost?: number | null
  }
): Promise<ResolvedInventoryIngredient> {
  const select = { id: true, name: true, unit: true, unitCost: true, quantity: true } as const

  if (params.ingredientId) {
    const found = await tx.inventoryItem.findFirst({
      where: { id: params.ingredientId, restaurantId: params.restaurantId, branchId: params.branchId },
      select,
    })
    if (!found) throw new Error('Ingredient not found')
    return found
  }

  const normalizedItemName = normalizeInventoryItemName(params.itemName || '')
  const sanitizedItemName = sanitizeInventoryItemName(params.itemName || '')
  if (!normalizedItemName) throw new Error('itemName is required')

  const existing = await tx.inventoryItem.findMany({
    where: { restaurantId: params.restaurantId, branchId: params.branchId },
    select,
  })
  const matched = existing.find((i) => normalizeInventoryItemName(i.name) === normalizedItemName) ?? null

  if (matched) {
    const usageUnit = params.unit?.trim() || matched.unit
    const unitChanged = matched.unit.toLowerCase() !== usageUnit.toLowerCase()
    if (unitChanged) {
      const ingredientPurchases = await tx.inventoryPurchase.findMany({
        where: { restaurantId: params.restaurantId, branchId: params.branchId, ingredientId: matched.id },
        select: { quantityPurchased: true, remainingQuantity: true },
      })
      if (ingredientPurchases.some(hasConsumedPurchaseQuantity)) {
        throw new Error('This ingredient has recorded stock consumption from orders. You cannot change the usage unit while that history exists.')
      }
    }
    if (!unitChanged && params.unitCost === undefined) return matched

    return tx.inventoryItem.update({
      where: { id: matched.id },
      data: {
        unit: usageUnit,
        ...(params.unitCost !== undefined ? { unitCost: params.unitCost ?? 0 } : {}),
      },
      select,
    })
  }

  const unit = params.unit?.trim()
  if (!unit) throw new Error('unit is required when recording a new item')

  return tx.inventoryItem.create({
    data: {
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      name: sanitizedItemName,
      unit,
      unitCost: params.unitCost ?? 0,
      quantity: 0,
      reorderLevel: 0,
      category: null,
    },
    select,
  })
}

async function resolveIngredientActiveUnitCost(
  tx: Prisma.TransactionClient,
  params: { restaurantId: string; branchId: string; ingredientId: string; fallbackUnitCost: number | null },
) {
  const openLayers = await tx.inventoryPurchase.findMany({
    where: { restaurantId: params.restaurantId, branchId: params.branchId, ingredientId: params.ingredientId, remainingQuantity: { gt: PURCHASE_USAGE_EPSILON } },
    select: { id: true, remainingQuantity: true, unitCost: true, purchasedAt: true, createdAt: true },
    orderBy: [{ purchasedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  })
  return getActiveFifoUnitCost(openLayers, params.fallbackUnitCost)
}

async function syncIngredientActiveUnitCost(
  tx: Prisma.TransactionClient,
  params: { restaurantId: string; branchId: string; ingredientId: string },
) {
  const ingredient = await tx.inventoryItem.findFirst({
    where: { id: params.ingredientId, restaurantId: params.restaurantId, branchId: params.branchId },
  })
  if (!ingredient) return null

  const activeUnitCost = await resolveIngredientActiveUnitCost(tx, {
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    ingredientId: params.ingredientId,
    fallbackUnitCost: ingredient.unitCost,
  })

  if (ingredient.unitCost === activeUnitCost) return ingredient

  return tx.inventoryItem.update({ where: { id: ingredient.id }, data: { unitCost: activeUnitCost ?? 0 } })
}

// GET — list all purchase batches
export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
    const restaurantId = context?.restaurantId ?? null
    const branchId = context?.branchId ?? null

    if (!restaurantId || !branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

    const { searchParams } = new URL(req.url)
    const ingredientId = searchParams.get('ingredientId')
    const from = searchParams.get('from')
    const to = searchParams.get('to')

    const purchases = await prisma.inventoryPurchase.findMany({
      where: {
        restaurantId,
        branchId,
        ...(ingredientId ? { ingredientId } : {}),
        ...(from && to ? { purchasedAt: { gte: new Date(from), lte: new Date(to + 'T23:59:59') } } : {}),
      },
      include: { ingredient: { select: { name: true, unit: true } } },
      orderBy: [{ createdAt: 'desc' }, { purchasedAt: 'desc' }],
    })

    return NextResponse.json(purchases)
  } catch (error: any) {
    console.error('Failed to load inventory purchases:', error)
    return NextResponse.json({ error: error?.message || 'Failed to load inventory purchases' }, { status: 500 })
  }
}

// POST — record a new purchase
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
    const restaurantId = context?.restaurantId ?? null
    const branchId = context?.branchId ?? null

    if (!restaurantId || !branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

    const body = await req.json()
    const { ingredientId, itemName, unit, supplier, paymentMethod, purchaseUnit } = body
    const normalizedBatchId = typeof body.batchId === 'string' && body.batchId.trim() ? body.batchId.trim() : null
    // Frontend sends purchaseQuantity (in purchase units) + purchaseUnitCost (per purchase unit).
    // Convert to usage-unit values for storage using the unitsPerPurchaseUnit ratio.
    const purchaseQuantity = Number(body.purchaseQuantity)
    const purchaseUnitCost = Number(body.purchaseUnitCost)
    const unitsPerPurchaseUnit = normalizeUnitsPerPurchaseUnit(body.unitsPerPurchaseUnit, 1)
    const quantityPurchased = toUsageQuantity(purchaseQuantity, unitsPerPurchaseUnit)
    const unitCost = toUsageUnitCost(purchaseUnitCost, unitsPerPurchaseUnit)
    const purchasedAt = body.purchasedAt ? new Date(body.purchasedAt) : new Date()

    if (!ingredientId && !(typeof itemName === 'string' && itemName.trim())) {
      return NextResponse.json({ error: 'itemName or ingredientId is required' }, { status: 400 })
    }
    if (!Number.isFinite(purchaseQuantity) || purchaseQuantity <= 0) {
      return NextResponse.json({ error: 'Quantity must be a valid number greater than 0' }, { status: 400 })
    }
    if (!Number.isFinite(purchaseUnitCost) || purchaseUnitCost < 0) {
      return NextResponse.json({ error: 'Cost per unit must be a valid number >= 0' }, { status: 400 })
    }
    if (Number.isNaN(purchasedAt.getTime())) {
      return NextResponse.json({ error: 'purchasedAt must be a valid date' }, { status: 400 })
    }

    const totalCost = quantityPurchased * unitCost
    const normalizedPaymentMethod = typeof paymentMethod === 'string' && paymentMethod.trim() ? paymentMethod.trim() : 'Cash'

    const result = await prisma.$transaction(async (tx) => {
      const ingredient = await resolveInventoryIngredient(tx, {
        restaurantId,
        branchId,
        ingredientId,
        itemName,
        unit,
        unitCost,
      })

      const journalEntry = await recordJournalEntry(tx, {
        restaurantId,
        branchId,
        date: purchasedAt,
        description: buildInventoryPurchaseDescription({ ingredientName: ingredient.name, ingredientUnit: ingredient.unit, quantityPurchased, supplier: supplier || null }),
        amount: totalCost,
        direction: 'out',
        accountName: 'Inventory Purchases',
        categoryType: 'expense',
        paymentMethod: normalizedPaymentMethod,
      })

      const createdPurchase = await tx.inventoryPurchase.create({
        data: {
          restaurantId,
          branchId,
          journalEntryId: journalEntry?.id ?? null,
          ingredientId: ingredient.id,
          batchId: normalizedBatchId,
          supplier: supplier || null,
          purchaseQuantity,
          purchaseUnit: purchaseUnit || unit || null,
          unitsPerPurchaseUnit,
          purchaseUnitCost,
          quantityPurchased,
          remainingQuantity: quantityPurchased,
          unitCost,
          totalCost,
          paymentMethod: normalizedPaymentMethod,
          purchasedAt,
        },
      })

      const hydratedPurchase = await tx.inventoryPurchase.findUnique({
        where: { id: createdPurchase.id },
        include: {
          ingredient: {
            select: {
              name: true,
              unit: true,
            },
          },
        },
      })

      await tx.inventoryItem.update({
        where: { id: ingredient.id },
        data: { quantity: { increment: quantityPurchased } },
      })

      const updatedIngredient = await syncIngredientActiveUnitCost(tx, { restaurantId, branchId, ingredientId: ingredient.id })
      if (!updatedIngredient) throw new Error('Ingredient not found after stock entry was created.')

      await enqueueSyncChange(tx, { restaurantId, branchId, entityType: 'inventoryPurchase', entityId: createdPurchase.id, operation: 'upsert', payload: createdPurchase })
      await enqueueSyncChange(tx, { restaurantId, branchId, entityType: 'inventoryItem', entityId: updatedIngredient.id, operation: 'upsert', payload: updatedIngredient })

      return {
        purchase: hydratedPurchase ?? createdPurchase,
        ingredient: updatedIngredient,
      }
    }, INVENTORY_TRANSACTION_OPTIONS)

    return NextResponse.json({ purchase: result.purchase, ingredient: result.ingredient, totalCost, batchId: normalizedBatchId }, { status: 201 })
  } catch (error: any) {
    console.error('Failed to record inventory purchase:', error)
    const status = ['Ingredient not found', 'itemName is required', 'unit is required when recording a new item'].includes(error?.message)
      || error?.message?.includes('cannot change the usage unit') ? 400 : 500
    return NextResponse.json({ error: error?.message || 'Failed to record inventory purchase', code: error?.code || null }, { status })
  }
}

export async function PUT(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
    const restaurantId = context?.restaurantId ?? null
    const branchId = context?.branchId ?? null

    if (!restaurantId || !branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

    const body = await req.json()
    const { id, ingredientId, itemName, unit, supplier, paymentMethod, purchaseUnit } = body
    const purchaseQuantity = Number(body.purchaseQuantity)
    const purchaseUnitCost = Number(body.purchaseUnitCost)
    const unitsPerPurchaseUnit = normalizeUnitsPerPurchaseUnit(body.unitsPerPurchaseUnit, 1)
    const quantityPurchased = toUsageQuantity(purchaseQuantity, unitsPerPurchaseUnit)
    const unitCost = toUsageUnitCost(purchaseUnitCost, unitsPerPurchaseUnit)
    const purchasedAt = body.purchasedAt ? new Date(body.purchasedAt) : new Date()

    if (!id || (!ingredientId && !(typeof itemName === 'string' && itemName.trim()))) {
      return NextResponse.json({ error: 'id and itemName or ingredientId are required' }, { status: 400 })
    }
    if (!Number.isFinite(purchaseQuantity) || purchaseQuantity <= 0) {
      return NextResponse.json({ error: 'Quantity must be a valid number greater than 0' }, { status: 400 })
    }
    if (!Number.isFinite(purchaseUnitCost) || purchaseUnitCost < 0) {
      return NextResponse.json({ error: 'Cost per unit must be a valid number >= 0' }, { status: 400 })
    }
    if (Number.isNaN(purchasedAt.getTime())) {
      return NextResponse.json({ error: 'purchasedAt must be a valid date' }, { status: 400 })
    }

    const totalCost = quantityPurchased * unitCost

    const existingPurchase = await prisma.inventoryPurchase.findFirst({
      where: { id, restaurantId, branchId },
    })

    if (!existingPurchase) return NextResponse.json({ error: 'Stock entry not found' }, { status: 404 })
    if (hasConsumedPurchaseQuantity(existingPurchase)) {
      return NextResponse.json({ error: 'This stock entry has already been used by orders, so editing is locked.' }, { status: 409 })
    }

    const normalizedPaymentMethod = typeof paymentMethod === 'string' && paymentMethod.trim() ? paymentMethod.trim() : 'Cash'

    const updatedPurchase = await prisma.$transaction(async (tx) => {
      const nextIngredient = await resolveInventoryIngredient(tx, {
        restaurantId,
        branchId,
        ingredientId,
        itemName,
        unit,
        unitCost,
      })

      if (existingPurchase.ingredientId === nextIngredient.id) {
        await tx.inventoryItem.update({
          where: { id: nextIngredient.id },
          data: { quantity: { increment: quantityPurchased - existingPurchase.quantityPurchased } },
        })
      } else {
        await tx.inventoryItem.update({ where: { id: existingPurchase.ingredientId }, data: { quantity: { decrement: existingPurchase.quantityPurchased } } })
        await tx.inventoryItem.update({ where: { id: nextIngredient.id }, data: { quantity: { increment: quantityPurchased } } })
      }

      // Update journal entry description/date if linked
      if (existingPurchase.journalEntryId) {
        await tx.journalEntry.update({
          where: { id: existingPurchase.journalEntryId },
          data: {
            description: buildInventoryPurchaseDescription({ ingredientName: nextIngredient.name, ingredientUnit: nextIngredient.unit, quantityPurchased, supplier: supplier || null }),
            entryDate: purchasedAt,
          },
        })
      }

      const purchase = await tx.inventoryPurchase.update({
        where: { id },
        data: {
          ingredientId: nextIngredient.id,
          supplier: supplier || null,
          purchaseQuantity,
          purchaseUnit: purchaseUnit || unit || null,
          unitsPerPurchaseUnit,
          purchaseUnitCost,
          quantityPurchased,
          remainingQuantity: quantityPurchased,
          unitCost,
          totalCost,
          paymentMethod: normalizedPaymentMethod,
          purchasedAt,
        },
      })

      const syncedIngredientIds = new Set([existingPurchase.ingredientId, nextIngredient.id])
      const syncedIngredients: ResolvedInventoryIngredient[] = []
      for (const syncedIngredientId of syncedIngredientIds) {
        const syncedIngredient = await syncIngredientActiveUnitCost(tx, { restaurantId, branchId, ingredientId: syncedIngredientId })
        if (!syncedIngredient) continue
        await enqueueSyncChange(tx, { restaurantId, branchId, entityType: 'inventoryItem', entityId: syncedIngredient.id, operation: 'upsert', payload: syncedIngredient })
        syncedIngredients.push(syncedIngredient)
      }

      await enqueueSyncChange(tx, { restaurantId, branchId, entityType: 'inventoryPurchase', entityId: purchase.id, operation: 'upsert', payload: purchase })

      const hydratedPurchase = await tx.inventoryPurchase.findUnique({
        where: { id: purchase.id },
        include: { ingredient: { select: { name: true, unit: true } } },
      })

      return { purchase: hydratedPurchase ?? purchase, ingredients: syncedIngredients }
    }, INVENTORY_TRANSACTION_OPTIONS)

    return NextResponse.json({ purchase: updatedPurchase.purchase, ingredients: updatedPurchase.ingredients })
  } catch (error: any) {
    console.error('Failed to update inventory purchase:', error)
    const status = ['Ingredient not found', 'itemName is required', 'unit is required when recording a new item'].includes(error?.message)
      || error?.message?.includes('cannot change the usage unit') ? 400 : 500
    return NextResponse.json({ error: error?.message || 'Failed to update inventory purchase', code: error?.code || null }, { status })
  }
}

export async function DELETE(req: Request) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
    const restaurantId = context?.restaurantId ?? null
    const branchId = context?.branchId ?? null

    if (!restaurantId || !branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

    const { searchParams } = new URL(req.url)
    const id = searchParams.get('id')
    if (!id) return NextResponse.json({ error: 'Stock entry id is required' }, { status: 400 })

    const existingPurchase = await prisma.inventoryPurchase.findFirst({
      where: { id, restaurantId, branchId },
    })

    if (!existingPurchase) return NextResponse.json({ error: 'Stock entry not found' }, { status: 404 })
    if (hasConsumedPurchaseQuantity(existingPurchase)) {
      return NextResponse.json({ error: 'This stock entry has already been used by orders, so deleting is locked.' }, { status: 409 })
    }

    const updatedIngredient = await prisma.$transaction(async (tx) => {
      const journalEntryId = existingPurchase.journalEntryId

      await tx.inventoryItem.update({
        where: { id: existingPurchase.ingredientId },
        data: { quantity: { decrement: existingPurchase.quantityPurchased } },
      })

      await tx.inventoryPurchase.delete({ where: { id } })

      if (journalEntryId) {
        await tx.journalEntry.delete({ where: { id: journalEntryId } })
      }

      const updatedIngredient = await syncIngredientActiveUnitCost(tx, { restaurantId, branchId, ingredientId: existingPurchase.ingredientId })
      if (!updatedIngredient) throw new Error('Ingredient not found after stock entry was deleted.')

      await enqueueSyncChange(tx, { restaurantId, branchId, entityType: 'inventoryPurchase', entityId: id, operation: 'delete', payload: { id } })
      await enqueueSyncChange(tx, { restaurantId, branchId, entityType: 'inventoryItem', entityId: updatedIngredient.id, operation: 'upsert', payload: updatedIngredient })

      return updatedIngredient
    }, INVENTORY_TRANSACTION_OPTIONS)

    return NextResponse.json({ success: true, ingredient: updatedIngredient })
  } catch (error: any) {
    console.error('Failed to delete inventory purchase:', error)
    return NextResponse.json({ error: error?.message || 'Failed to delete inventory purchase', code: error?.code || null }, { status: 500 })
  }
}
