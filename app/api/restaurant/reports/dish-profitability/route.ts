import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { getRestaurantOrderDisplayStatus } from '@/lib/restaurantOrders'

function parseDateParam(value: string | null, endOfDay = false) {
  if (!value) return null
  const parsed = new Date(`${value}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return null
  if (endOfDay) parsed.setHours(23, 59, 59, 999)
  return parsed
}

// GET — order sales report
// ?from=YYYY-MM-DD&to=YYYY-MM-DD
export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null
  if (!restaurantId || !branchId) {
    return NextResponse.json({ rows: [], dishes: [], orders: [], totals: { qtySold: 0, totalQtySold: 0, totalRevenue: 0, totalCost: 0, totalPrice: 0, totalProfit: 0, avgMargin: 0 } })
  }

  const { searchParams } = new URL(req.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')
  const fromDate = parseDateParam(from)
  const toDate = parseDateParam(to, true)

  // Station comes from the caller when supplied (validated against this
  // restaurant) so a request fired right after a station switch isn't scoped to
  // the station just left, while the session's copy catches up in the background.
  const requestedBranchId = searchParams.get('branchId')?.trim() || null
  const activeBranch = await prisma.branch.findFirst({
    where: { id: requestedBranchId ?? branchId, restaurantId },
    select: { id: true, isMain: true },
  })
  if (!activeBranch) {
    return NextResponse.json({ rows: [], dishes: [], orders: [], totals: { qtySold: 0, totalQtySold: 0, totalRevenue: 0, totalCost: 0, totalPrice: 0, totalProfit: 0, avgMargin: 0 } })
  }
  // Main reports the whole restaurant rather than a single station's slice.
  const scopedBranchId = activeBranch.isMain ? null : activeBranch.id

  // One order/table/bill can carry dishes prepared by several stations (a
  // burger + a soda + a dessert is one guest visit, three kitchens). Which
  // station a dish's revenue and cost belong to is decided by the dish's own
  // branch, never by the order's till branch — so orders are fetched restaurant-
  // wide here and then filtered down to just this station's line items below.
  const orders = await prisma.restaurantOrder.findMany({
    where: {
      restaurantId,
      status: 'PAID',
      ...(fromDate || toDate
        ? {
            paidAt: {
              ...(fromDate ? { gte: fromDate } : {}),
              ...(toDate ? { lte: toDate } : {}),
            },
          }
        : {}),
    },
    include: {
      table: { select: { name: true } },
      items: {
        where: { status: 'ACTIVE' },
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { paidAt: 'desc' },
  })

  const orderIds = orders.map((order) => order.id)
  const dishIds = Array.from(new Set(orders.flatMap((order) => order.items.map((item) => item.dishId))))

  const [sales, dishes] = await Promise.all([
    orderIds.length > 0
      ? prisma.dishSale.findMany({
          where: {
            orderId: { in: orderIds },
            restaurantId,
            ...(scopedBranchId ? { branchId: scopedBranchId } : {}),
            deletedAt: null,
          },
          select: {
            orderId: true,
            orderItemId: true,
            calculatedFoodCost: true,
          },
        })
      : Promise.resolve([]),
    dishIds.length > 0
      ? prisma.dish.findMany({
          where: {
            id: { in: dishIds },
            restaurantId,
          },
          include: {
            ingredients: {
              include: {
                inventoryItem: {
                  select: { unitCost: true },
                },
              },
            },
          },
        })
      : Promise.resolve([]),
  ])

  const dishById = new Map(dishes.map((dish) => [dish.id, dish]))

  // Actual costs are keyed by orderItemId so a partially-recorded order (some
  // items have a DishSale, some don't) still gets an estimate for the gap
  // instead of the whole order falling back to estimates.
  const actualCostByOrderItemId = new Map<string, number>()
  for (const sale of sales) {
    if (!sale.orderItemId) continue
    actualCostByOrderItemId.set(
      sale.orderItemId,
      (actualCostByOrderItemId.get(sale.orderItemId) ?? 0) + Number(sale.calculatedFoodCost ?? 0)
    )
  }

  const estimatedUnitCostByDishId = new Map(
    dishes.map((dish) => [
      dish.id,
      dish.ingredients.reduce((sum, ingredientRow) => (
        sum + (Number(ingredientRow.quantityRequired ?? 0) * Number(ingredientRow.inventoryItem.unitCost ?? 0))
      ), 0),
    ])
  )

  const rows = orders.flatMap((order) => {
    // This station's slice of the order — dishes belonging to other stations
    // in the same order are reported by those stations, not here. Main takes
    // every item, since it reports the restaurant as a whole.
    const stationItems = scopedBranchId
      ? order.items.filter((item) => dishById.get(item.dishId)?.branchId === scopedBranchId)
      : order.items
    if (stationItems.length === 0) return []

    const qtySold = stationItems.reduce((sum, item) => sum + Number(item.qty ?? 0), 0)
    // OrderItem.totalPrice is only populated by the QR-order submit path and
    // is 0 for items created elsewhere (desktop/waiter order-taking) — qty *
    // dishPrice is the reliably-populated line-item revenue.
    const totalPrice = stationItems.reduce((sum, item) => sum + Number(item.qty ?? 0) * Number(item.dishPrice ?? 0), 0)
    const totalCost = stationItems.reduce((sum, item) => {
      const actual = actualCostByOrderItemId.get(item.id)
      if (actual !== undefined) return sum + actual
      const estimatedUnitCost = Number(estimatedUnitCostByDishId.get(item.dishId) ?? 0)
      return sum + Number(item.qty ?? 0) * estimatedUnitCost
    }, 0)
    const unitPrice = qtySold > 0 ? totalPrice / qtySold : 0
    const unitCost = qtySold > 0 ? totalCost / qtySold : 0
    const totalProfit = totalPrice - totalCost
    const status = getRestaurantOrderDisplayStatus(order)

    return [{
      id: order.id,
      orderId: order.id,
      orderLabel: order.orderNumber,
      tableName: order.table?.name ?? order.tableName ?? 'Takeaway',
      waiterName: order.createdByName ?? null,
      dishNames: stationItems.map((item) => item.dishName),
      status,
      qtySold,
      unitCost,
      unitPrice,
      totalCost,
      totalPrice,
      totalRevenue: totalPrice,
      totalProfit,
      profitMargin: totalPrice > 0 ? Math.round((totalProfit / totalPrice) * 100) : 0,
      saleDate: order.paidAt ?? order.createdAt,
    }]
  })

  const totals = rows.reduce((acc, r) => ({
    qtySold: acc.qtySold + r.qtySold,
    totalRevenue: acc.totalRevenue + r.totalRevenue,
    totalCost: acc.totalCost + r.totalCost,
    totalProfit: acc.totalProfit + r.totalProfit,
  }), { qtySold: 0, totalRevenue: 0, totalCost: 0, totalProfit: 0 })

  return NextResponse.json({
    rows,
    dishes: rows,
    orders: rows,
    totals: {
      qtySold: totals.qtySold,
      totalQtySold: totals.qtySold,
      totalRevenue: totals.totalRevenue,
      totalCost: totals.totalCost,
      totalPrice: totals.totalRevenue,
      totalProfit: totals.totalProfit,
      avgMargin: totals.totalRevenue > 0
        ? Math.round((totals.totalProfit / totals.totalRevenue) * 100)
        : 0,
    },
  })
}
