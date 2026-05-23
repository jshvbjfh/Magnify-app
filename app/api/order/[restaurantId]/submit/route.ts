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

    if (!resolvedBranchId) return NextResponse.json({ error: 'No branch found for this restaurant' }, { status: 400 })
    const branchId: string = resolvedBranchId

    const requestedDishIds = Array.from(new Set(items.map((item: { dishId: string }) => String(item?.dishId || '')).filter(Boolean)))
    const dishes = await prisma.dish.findMany({
      where: { id: { in: requestedDishIds }, restaurantId: resolvedRestaurantId, branchId, isActive: true },
      select: {
        id: true,
        name: true,
        sellingPrice: true,
        variants: {
          where: { isActive: true, deletedAt: null },
          select: { id: true, name: true, sellingPrice: true },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
    })

    const dishMap = new Map(dishes.map((dish) => [dish.id, dish]))
    const normalizedItems = items.map((item: { dishId: string; dishVariantId?: string | null; qty: number }) => {
      const dish = dishMap.get(String(item.dishId))
      const qty = Number(item.qty) || 1
      const requestedVariantId = String(item.dishVariantId ?? '').trim()
      const variant = requestedVariantId ? dish?.variants.find((row) => row.id === requestedVariantId) : null
      if (!dish || qty <= 0) return null
      if (dish.variants.length > 0 && !variant) return null

      return {
        dishId: dish.id,
        dishVariantId: variant?.id ?? null,
        dishVariantName: variant?.name ?? null,
        dishName: buildDishVariantLabel(dish.name, variant?.name),
        dishPrice: variant?.sellingPrice ?? dish.sellingPrice,
        qty,
      }
    }).filter(Boolean) as Array<{
      dishId: string
      dishVariantId: string | null
      dishVariantName: string | null
      dishName: string
      dishPrice: number
      qty: number
    }>

    if (normalizedItems.length === 0 || normalizedItems.length !== items.length) {
      return NextResponse.json({ error: 'One or more menu items are no longer available. Please refresh and try again.' }, { status: 400 })
    }

    const totals = calculateRestaurantOrderTotals(normalizedItems)

    let created = false
    let createdOrderId: string | null = null
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await prisma.$transaction(async (tx) => {
          const txDb = tx as typeof prisma

          const order = await txDb.restaurantOrder.create({
            data: {
              restaurantId: resolvedRestaurantId,
              branchId,
              status: 'PENDING',
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
            data: normalizedItems.map((item) => ({
              orderId: order.id,
              dishId: item.dishId,
              dishVariantId: item.dishVariantId,
              dishVariantName: item.dishVariantName,
              dishName: item.dishName,
              dishPrice: item.dishPrice,
              qty: item.qty,
              totalPrice: item.dishPrice * item.qty,
            })),
          })

          if (tableId) {
            await txDb.restaurantTable.update({ where: { id: tableId }, data: { status: 'occupied' } })
            await enqueueRestaurantTableSync(txDb, tableId, resolvedRestaurantId)
          }

          createdOrderId = order.id
        })
        created = true
        if (createdOrderId) {
          await enqueueOrderSync(prisma, createdOrderId, resolvedRestaurantId, branchId)
        }
        break
      } catch (error) {
        if (!isRestaurantOrderNumberConflict(error) || attempt === 4) throw error
      }
    }

    if (!created) return NextResponse.json({ error: 'Failed to place order. Please try again.' }, { status: 500 })
    return NextResponse.json({ success: true }, { status: 201 })
  } catch (error) {
    console.error('QR order submit failed:', error)
    return NextResponse.json({ error: 'Failed to place order. Please try again.' }, { status: 500 })
  }
}
