import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser, isMainRestaurantBranch } from '@/lib/restaurantAccess'
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

  const context = await getRestaurantContextForUser(session.user.id)
  const billingUserId = context?.billingUserId ?? session.user.id
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null
  if (!restaurantId || !branchId) {
    return NextResponse.json({ rows: [], dishes: [], orders: [], totals: { qtySold: 0, totalQtySold: 0, totalRevenue: 0, totalCost: 0, totalPrice: 0, totalProfit: 0, avgMargin: 0 } })
  }

  const includeBranchlessRows = await isMainRestaurantBranch(restaurantId, branchId)
  const branchScopeWhere = includeBranchlessRows
    ? { OR: [{ branchId }, { branchId: null }] }
    : { branchId }

  const { searchParams } = new URL(req.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')
  const fromDate = parseDateParam(from)
  const toDate = parseDateParam(to, true)

  const orders = await prisma.restaurantOrder.findMany({
    where: {
      restaurantId,
      ...branchScopeWhere,
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
            userId: billingUserId,
            orderId: { in: orderIds },
            ...(restaurantId ? { restaurantId } : {}),
            ...branchScopeWhere,
          },
          select: {
            orderId: true,
            quantitySold: true,
            calculatedFoodCost: true,
          },
        })
      : Promise.resolve([]),
    dishIds.length > 0
      ? prisma.dish.findMany({
          where: {
            id: { in: dishIds },
            userId: billingUserId,
            ...(restaurantId ? { restaurantId } : {}),
            ...branchScopeWhere,
          },
          include: {
            ingredients: {
              include: {
                ingredient: {
                  select: { unitCost: true },
                },
              },
            },
          },
        })
      : Promise.resolve([]),
  ])

  const actualCostByOrderId = new Map<string, number>()
  for (const sale of sales) {
    if (!sale.orderId) continue
    actualCostByOrderId.set(
      sale.orderId,
      (actualCostByOrderId.get(sale.orderId) ?? 0) + Number(sale.calculatedFoodCost ?? 0)
    )
  }

  const estimatedUnitCostByDishId = new Map(
    dishes.map((dish) => [
      dish.id,
      dish.ingredients.reduce((sum, ingredientRow) => (
        sum + (Number(ingredientRow.quantityRequired ?? 0) * Number(ingredientRow.ingredient.unitCost ?? 0))
      ), 0),
    ])
  )

  const rows = orders.map((order) => {
    const qtySold = order.items.reduce((sum, item) => sum + Number(item.qty ?? 0), 0)
    const estimatedCost = order.items.reduce((sum, item) => (
      sum + (Number(item.qty ?? 0) * Number(estimatedUnitCostByDishId.get(item.dishId) ?? 0))
    ), 0)
    const totalCost = actualCostByOrderId.has(order.id)
      ? Number(actualCostByOrderId.get(order.id) ?? 0)
      : estimatedCost
    const totalPrice = Number(order.totalAmount ?? 0)
    const unitPrice = qtySold > 0 ? totalPrice / qtySold : 0
    const unitCost = qtySold > 0 ? totalCost / qtySold : 0
    const totalProfit = totalPrice - totalCost
    const status = getRestaurantOrderDisplayStatus(order)

    return {
      id: order.id,
      orderId: order.id,
      orderLabel: order.orderNumber,
      tableName: order.table?.name ?? order.tableName ?? 'Takeaway',
      waiterName: order.createdByName ?? null,
      dishNames: order.items.map((item) => item.dishName),
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
    }
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
