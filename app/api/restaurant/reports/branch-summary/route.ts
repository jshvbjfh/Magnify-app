import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { endOfRestaurantDay, startOfRestaurantDay } from '@/lib/restaurantDay'

// Money must never be served from a cache. Without this, Next can cache the
// GET response and keep returning figures from before a correction landed —
// the page looks fine, refreshes cleanly, and still shows yesterday's numbers.
export const dynamic = 'force-dynamic'

function parseDateParam(value: string | null, endOfDay = false) {
  // Days are restaurant days, not server days — see lib/restaurantDay.
  return endOfDay ? endOfRestaurantDay(value) : startOfRestaurantDay(value)
}

// GET — sales, cost of goods sold and profit/loss rolled up per station for the whole restaurant account.
// Each dish is attributed to the STATION THAT OWNS THE DISH, not the station the order was placed
// at — an order can span multiple stations (e.g. a Parking Bar waiter selling a Little Taipei dish),
// so revenue/cost for each line item belongs to that dish's own station, mirroring the attribution
// already used when recording DishSale rows (see lib/dishSaleRecording.ts).
// ?from=YYYY-MM-DD&to=YYYY-MM-DD
export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  if (!restaurantId) {
    return NextResponse.json({ rows: [], totals: { totalSales: 0, totalCost: 0, totalProfit: 0 } })
  }

  const { searchParams } = new URL(req.url)
  const fromDate = parseDateParam(searchParams.get('from'))
  const toDate = parseDateParam(searchParams.get('to'), true)

  const branches = await prisma.branch.findMany({
    where: { restaurantId, deletedAt: null },
    select: { id: true, name: true, isMain: true },
    orderBy: [{ isMain: 'desc' }, { name: 'asc' }],
  })

  const orders = await prisma.restaurantOrder.findMany({
    where: {
      restaurantId,
      status: 'PAID',
      ...(fromDate || toDate
        ? { paidAt: { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lte: toDate } : {}) } }
        : {}),
    },
    select: { id: true, branchId: true },
  })

  const orderIds = orders.map((order) => order.id)
  const orderBranchById = new Map(orders.map((order) => [order.id, order.branchId]))

  const [sales, items] = await Promise.all([
    orderIds.length > 0
      ? prisma.dishSale.findMany({
          where: { orderId: { in: orderIds }, restaurantId },
          select: { orderId: true, orderItemId: true, dishId: true, branchId: true, totalSaleAmount: true, calculatedFoodCost: true },
        })
      : Promise.resolve([]),
    orderIds.length > 0
      ? prisma.orderItem.findMany({
          where: { orderId: { in: orderIds }, status: 'ACTIVE' },
          select: { id: true, orderId: true, dishId: true, qty: true, dishPrice: true },
        })
      : Promise.resolve([]),
  ])

  // DishSale rows already carry the correct per-dish station (see dishSaleRecording.ts) — index
  // by orderItemId (the normal case) and by orderId+dishId (legacy rows without an orderItemId).
  const saleByOrderItemId = new Map(sales.filter((s) => s.orderItemId).map((s) => [s.orderItemId as string, s]))
  const saleByOrderAndDish = new Map<string, (typeof sales)[number]>()
  for (const sale of sales) {
    if (sale.orderItemId || !sale.orderId) continue
    saleByOrderAndDish.set(`${sale.orderId}::${sale.dishId}`, sale)
  }

  const dishIds = Array.from(new Set(items.map((item) => item.dishId)))
  const dishes = dishIds.length > 0
    ? await prisma.dish.findMany({
        where: { id: { in: dishIds }, restaurantId },
        include: { ingredients: { include: { inventoryItem: { select: { unitCost: true } } } } },
      })
    : []
  const dishById = new Map(dishes.map((dish) => [dish.id, dish]))
  const estimatedUnitCostByDishId = new Map(
    dishes.map((dish) => [
      dish.id,
      dish.ingredients.reduce((sum, ingredientRow) => (
        sum + (Number(ingredientRow.quantityRequired ?? 0) * Number(ingredientRow.inventoryItem.unitCost ?? 0))
      ), 0),
    ])
  )

  const salesByBranch = new Map<string, number>()
  const costByBranch = new Map<string, number>()
  const addToBranch = (map: Map<string, number>, branchId: string, amount: number) => {
    map.set(branchId, (map.get(branchId) ?? 0) + amount)
  }

  for (const item of items) {
    const sale = saleByOrderItemId.get(item.id) ?? saleByOrderAndDish.get(`${item.orderId}::${item.dishId}`)
    // Attribute to the dish's own station. Falls back to the order's station only when even the
    // dish record has no branch — shouldn't normally happen.
    const branchId = sale?.branchId ?? dishById.get(item.dishId)?.branchId ?? orderBranchById.get(item.orderId) ?? null
    if (!branchId) continue

    const saleAmount = sale ? Number(sale.totalSaleAmount ?? 0) : Number(item.dishPrice ?? 0) * Number(item.qty ?? 0)
    const cost = sale
      ? Number(sale.calculatedFoodCost ?? 0)
      : Number(item.qty ?? 0) * (estimatedUnitCostByDishId.get(item.dishId) ?? 0)

    addToBranch(salesByBranch, branchId, saleAmount)
    addToBranch(costByBranch, branchId, cost)
  }

  const totalSales = Array.from(salesByBranch.values()).reduce((sum, v) => sum + v, 0)

  const rows = branches.map((branch) => {
    const sales = salesByBranch.get(branch.id) ?? 0
    const cost = costByBranch.get(branch.id) ?? 0
    const profit = sales - cost
    return {
      branchId: branch.id,
      branchName: branch.name,
      sales,
      cost,
      profit,
      percentOfSales: totalSales > 0 ? Math.round((sales / totalSales) * 1000) / 10 : 0,
      marginPercent: sales > 0 ? Math.round((profit / sales) * 1000) / 10 : 0,
    }
  }).filter((row) => row.sales > 0 || row.cost > 0)

  const totals = rows.reduce((acc, r) => ({
    totalSales: acc.totalSales + r.sales,
    totalCost: acc.totalCost + r.cost,
    totalProfit: acc.totalProfit + r.profit,
  }), { totalSales: 0, totalCost: 0, totalProfit: 0 })

  return NextResponse.json({ rows, totals })
}
