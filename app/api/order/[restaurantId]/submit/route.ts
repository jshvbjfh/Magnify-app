import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { calculateRestaurantOrderTotals, generateRestaurantOrderNumber, isRestaurantOrderNumberConflict } from '@/lib/restaurantOrders'
import { enqueueRestaurantTableSync } from '@/lib/restaurantTableSync'
import { ensureMainBranchForRestaurant } from '@/lib/restaurantAccess'

// Public — no auth required. Customer submits order from the table menu page.
export async function POST(req: Request, { params }: { params: Promise<{ restaurantId: string }> }) {
  try {
    const { restaurantId } = await params

    // Try primary ID first, then fall back to syncRestaurantId (QR from a different device)
    let restaurantRecord = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
    })
    if (!restaurantRecord) {
      restaurantRecord = await prisma.restaurant.findUnique({
        where: { syncRestaurantId: restaurantId },
      })
    }
    const restaurant = restaurantRecord as ({ id: string; ownerId: string; qrOrderingMode?: string | null } | null)
    if (!restaurant) return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 })
    const resolvedRestaurantId = restaurant.id
    if ((restaurant.qrOrderingMode ?? 'disabled') === 'disabled') {
      return NextResponse.json({ error: 'Guest ordering is disabled for this restaurant.' }, { status: 403 })
    }
    if ((restaurant.qrOrderingMode ?? 'order') !== 'order') {
      return NextResponse.json({ error: 'This menu is in view-only mode. Guests can browse the menu but cannot place orders.' }, { status: 403 })
    }

    const body = await req.json()
    const { tableId, tableName, items, customerName } = body

    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'No items in order' }, { status: 400 })
    }

    let resolvedTableName = tableName || 'Guest Order'
    let resolvedBranchId: string | null = null
    if (tableId) {
      const table = await prisma.restaurantTable.findFirst({
        where: { id: tableId, restaurantId: resolvedRestaurantId },
        select: { id: true, name: true, branchId: true },
      })
      if (!table) return NextResponse.json({ error: 'Table not found' }, { status: 404 })
      resolvedTableName = table.name
      resolvedBranchId = table.branchId ?? null
    }

    if (!resolvedBranchId) {
      const mainBranch = await ensureMainBranchForRestaurant(resolvedRestaurantId)
      resolvedBranchId = mainBranch?.id ?? null
    }

    const requestedDishIds = Array.from(new Set(items.map((item: { dishId: string }) => String(item?.dishId || '')).filter(Boolean)))
    const dishes = await prisma.dish.findMany({
      where: {
        id: { in: requestedDishIds },
        userId: restaurant.ownerId,
        restaurantId: resolvedRestaurantId,
        ...(resolvedBranchId
          ? { OR: [{ branchId: resolvedBranchId }, { branchId: null }] }
          : {}),
        isActive: true,
      },
      select: { id: true, name: true, sellingPrice: true },
    })

    const dishMap = new Map(dishes.map((dish) => [dish.id, dish]))
    const normalizedItems = items.map((item: { dishId: string; qty: number }) => {
      const dish = dishMap.get(String(item.dishId))
      const qty = Number(item.qty) || 1
      if (!dish || qty <= 0) return null
      return {
        dishId: dish.id,
        dishName: dish.name,
        dishPrice: dish.sellingPrice,
        qty,
      }
    }).filter(Boolean) as Array<{ dishId: string; dishName: string; dishPrice: number; qty: number }>

    if (normalizedItems.length === 0 || normalizedItems.length !== items.length) {
      return NextResponse.json({ error: 'One or more menu items are no longer available. Please refresh and try again.' }, { status: 400 })
    }

    const totals = calculateRestaurantOrderTotals(normalizedItems)

    let created = false
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await prisma.$transaction(async (tx) => {
          const txDb = tx as typeof prisma

          const order = await txDb.restaurantOrder.create({
            data: {
              restaurantId: resolvedRestaurantId,
              branchId: resolvedBranchId,
              tableId: tableId || null,
              tableName: resolvedTableName,
              orderNumber: await generateRestaurantOrderNumber(txDb, resolvedRestaurantId),
              createdById: restaurant.ownerId,
              createdByName: customerName ? `Guest - ${String(customerName).trim()}` : 'Guest QR Order',
              subtotalAmount: totals.subtotalAmount,
              vatAmount: totals.vatAmount,
              totalAmount: totals.totalAmount,
            },
          })

          await txDb.restaurantOrderItem.createMany({
            data: normalizedItems.map((item) => ({
              orderId: order.id,
              dishId: item.dishId,
              dishName: item.dishName,
              dishPrice: item.dishPrice,
              qty: item.qty,
            })),
          })

          if (tableId) {
            await txDb.restaurantTable.update({
              where: { id: tableId },
              data: { status: 'occupied' },
            })
            await enqueueRestaurantTableSync(txDb, tableId, resolvedRestaurantId)
          }
        })
        created = true
        break
      } catch (error) {
        if (!isRestaurantOrderNumberConflict(error) || attempt === 4) throw error
      }
    }

    if (!created) {
      return NextResponse.json({ error: 'Failed to place order. Please try again.' }, { status: 500 })
    }

    return NextResponse.json({ success: true }, { status: 201 })
  } catch (error) {
    console.error('QR order submit failed:', error)
    return NextResponse.json({ error: 'Failed to place order. Please try again.' }, { status: 500 })
  }
}
