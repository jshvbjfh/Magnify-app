import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { buildDishVariantLabel } from '@/lib/dishVariants'
import { calculateRestaurantOrderTotals, enqueueOrderSync, generateRestaurantOrderNumber, isRestaurantOrderNumberConflict } from '@/lib/restaurantOrders'
import { enqueueRestaurantTableSync } from '@/lib/restaurantTableSync'
import { ensureMainBranchForRestaurant } from '@/lib/restaurantAccess'

export async function POST(req: Request, { params }: { params: Promise<{ restaurantId: string }> }) {
  try {
    const { restaurantId } = await params

    const restaurantRecord = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { id: true, qrOrderingMode: true },
    })
    if (!restaurantRecord) return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 })
    const resolvedRestaurantId = restaurantRecord.id

    if (restaurantRecord.qrOrderingMode !== 'order') {
      return NextResponse.json({ error: 'Guest QR ordering is not enabled for this restaurant.' }, { status: 403 })
    }

    const body = await req.json()
    const { tableId, tableName, items, customerName } = body

    if (!Array.isArray(items) || items.length === 0) {
      return NextResponse.json({ error: 'No items in order' }, { status: 400 })
    }

    let resolvedTableName = tableName || 'Guest Order'
    let tableBranchId: string | null = null
    if (tableId) {
      const table = await prisma.restaurantTable.findFirst({
        where: { id: tableId, restaurantId: resolvedRestaurantId },
        select: { id: true, name: true, branchId: true },
      })
      if (!table) return NextResponse.json({ error: 'Table not found' }, { status: 404 })
      resolvedTableName = table.name
      tableBranchId = table.branchId ?? null
    }

    const fallbackBranchId = tableBranchId ?? (await ensureMainBranchForRestaurant(resolvedRestaurantId))?.id ?? null
    if (!fallbackBranchId) return NextResponse.json({ error: 'No station found for this restaurant' }, { status: 400 })

    // Fetch dishes across ALL branches — dishes are restaurant-wide on the QR menu
    const requestedDishIds = Array.from(new Set(items.map((item: { dishId: string }) => String(item?.dishId || '')).filter(Boolean)))
    const dishes = await prisma.dish.findMany({
      where: { id: { in: requestedDishIds }, restaurantId: resolvedRestaurantId, isActive: true, deletedAt: null },
      select: {
        id: true,
        name: true,
        sellingPrice: true,
        branchId: true,
        variants: {
          where: { isActive: true, deletedAt: null },
          select: { id: true, name: true, sellingPrice: true },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
    })

    const dishMap = new Map(dishes.map((dish) => [dish.id, dish]))
    type NormalizedItem = {
      dishId: string
      dishBranchId: string
      dishVariantId: string | null
      dishVariantName: string | null
      dishName: string
      dishPrice: number
      qty: number
    }

    const normalizedItems = items.map((item: { dishId: string; dishVariantId?: string | null; qty: number }) => {
      const dish = dishMap.get(String(item.dishId))
      const qty = Number(item.qty) || 1
      const requestedVariantId = String(item.dishVariantId ?? '').trim()
      const variant = requestedVariantId ? dish?.variants.find((row) => row.id === requestedVariantId) : null
      if (!dish || qty <= 0) return null
      if (dish.variants.length > 0 && !variant) return null

      return {
        dishId: dish.id,
        dishBranchId: dish.branchId ?? fallbackBranchId,
        dishVariantId: variant?.id ?? null,
        dishVariantName: variant?.name ?? null,
        dishName: buildDishVariantLabel(dish.name, variant?.name),
        dishPrice: variant?.sellingPrice ?? dish.sellingPrice,
        qty,
      } satisfies NormalizedItem
    }).filter(Boolean) as NormalizedItem[]

    if (normalizedItems.length === 0 || normalizedItems.length !== items.length) {
      return NextResponse.json({ error: 'One or more menu items are no longer available. Please refresh and try again.' }, { status: 400 })
    }

    // Group items by the dish's branch so each branch gets its own order record
    const itemsByBranch = new Map<string, NormalizedItem[]>()
    for (const item of normalizedItems) {
      const bid = item.dishBranchId
      if (!itemsByBranch.has(bid)) itemsByBranch.set(bid, [])
      itemsByBranch.get(bid)!.push(item)
    }

    const createdOrderIds: string[] = []
    let tableMarkedOccupied = false

    for (const [orderBranchId, branchItems] of itemsByBranch) {
      const totals = calculateRestaurantOrderTotals(branchItems)
      let success = false

      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          let newOrderId: string | null = null
          await prisma.$transaction(async (tx) => {
            const txDb = tx as typeof prisma

            const order = await txDb.restaurantOrder.create({
              data: {
                restaurantId: resolvedRestaurantId,
                branchId: orderBranchId,
                // Guest QR orders are held as UNCONFIRMED until a waiter confirms them.
                // The kitchen only lists PENDING/OPEN orders, so this gates QR orders
                // out of the kitchen until the waiter confirms (→ status becomes PENDING).
                status: 'UNCONFIRMED',
                tableId: tableId || null,
                tableName: resolvedTableName,
                orderNumber: await generateRestaurantOrderNumber(txDb, resolvedRestaurantId),
                createdByName: customerName ? `Guest - ${String(customerName).trim()}` : 'Guest QR Order',
                subtotalAmount: totals.subtotalAmount,
                vatAmount: totals.vatAmount,
                totalAmount: totals.totalAmount,
              },
            })

            await txDb.orderItem.createMany({
              data: branchItems.map((item) => ({
                orderId: order.id,
                dishId: item.dishId,
                dishVariantId: item.dishVariantId,
                dishVariantName: item.dishVariantName,
                dishName: item.dishName,
                dishPrice: item.dishPrice,
                qty: item.qty,
                totalPrice: item.dishPrice * item.qty,
                branchId: item.dishBranchId,
              })),
            })

            if (tableId && !tableMarkedOccupied) {
              await txDb.restaurantTable.update({ where: { id: tableId }, data: { status: 'occupied' } })
              await enqueueRestaurantTableSync(txDb, tableId, resolvedRestaurantId)
              tableMarkedOccupied = true
            }

            newOrderId = order.id
          })

          if (newOrderId) {
            createdOrderIds.push(newOrderId)
            await enqueueOrderSync(prisma, newOrderId, resolvedRestaurantId, orderBranchId)
          }
          success = true
          break
        } catch (error) {
          if (!isRestaurantOrderNumberConflict(error) || attempt === 4) throw error
        }
      }

      if (!success) return NextResponse.json({ error: 'Failed to place order. Please try again.' }, { status: 500 })
    }

    return NextResponse.json({ success: true }, { status: 201 })
  } catch (error) {
    console.error('QR order submit failed:', error)
    return NextResponse.json({ error: 'Failed to place order. Please try again.' }, { status: 500 })
  }
}
