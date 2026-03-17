import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

function startOf(period: 'today' | 'week' | 'month'): Date {
  const now = new Date()
  if (period === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (period === 'week') {
    const d = new Date(now); d.setDate(d.getDate() - 6); d.setHours(0, 0, 0, 0); return d
  }
  return new Date(now.getFullYear(), now.getMonth(), 1)
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const userRole = (session.user as any).role
  const userId   = session.user.id

  // Resolve the manager's userId whose data we'll read
  let managerUserId: string
  let restaurantId: string

  if (userRole === 'owner') {
    const rid = (session.user as any).restaurantId
    if (!rid) return NextResponse.json({ error: 'No restaurant linked to this owner account' }, { status: 403 })
    const restaurant = await prisma.restaurant.findUnique({ where: { id: rid } })
    if (!restaurant) return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 })
    managerUserId = restaurant.ownerId
    restaurantId  = rid
  } else if (userRole === 'admin') {
    managerUserId = userId
    const restaurant = await prisma.restaurant.findUnique({ where: { ownerId: userId } })
    if (!restaurant) return NextResponse.json({ error: 'Restaurant not set up yet' }, { status: 404 })
    restaurantId = restaurant.id
  } else {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { searchParams } = new URL(req.url)
  const period = (searchParams.get('period') ?? 'today') as 'today' | 'week' | 'month'
  const from = startOf(period)
  const to   = new Date()

  // Revenue & food cost from dish sales
  const sales = await prisma.dishSale.findMany({
    where: { userId: managerUserId, saleDate: { gte: from, lte: to } },
    include: { dish: { select: { name: true } } },
  })
  const revenue = sales.reduce((s, x) => s + (x.totalSaleAmount ?? 0), 0)
  const cogs    = sales.reduce((s, x) => s + (x.calculatedFoodCost ?? 0), 0)
  const foodCostPct = revenue > 0 ? (cogs / revenue) * 100 : 0

  // Labor
  const shifts    = await prisma.shift.findMany({ where: { userId: managerUserId, date: { gte: from, lte: to } } })
  const laborCost = shifts.reduce((s, x) => s + (x.calculatedWage ?? 0), 0)
  const laborPct  = revenue > 0 ? (laborCost / revenue) * 100 : 0

  // Waste
  const wasteLogs = await prisma.wasteLog.findMany({ where: { userId: managerUserId, date: { gte: from, lte: to } } })
  const wasteCost = wasteLogs.reduce((s, x) => s + (x.calculatedCost ?? 0), 0)
  const wastePct  = revenue > 0 ? (wasteCost / revenue) * 100 : 0

  // Top 5 dishes
  const dishMap: Record<string, { name: string; revenue: number; qty: number }> = {}
  for (const s of sales) {
    if (!dishMap[s.dishId]) dishMap[s.dishId] = { name: s.dish.name, revenue: 0, qty: 0 }
    dishMap[s.dishId].revenue += s.totalSaleAmount ?? 0
    dishMap[s.dishId].qty    += s.quantitySold ?? 0
  }
  const topDishes = Object.values(dishMap).sort((a, b) => b.revenue - a.revenue).slice(0, 5)

  // Low stock ingredients
  const ingredients = await prisma.inventoryItem.findMany({
    where: { userId: managerUserId, inventoryType: 'ingredient' },
  })
  const lowStock = ingredients
    .filter(i => i.quantity <= (i.reorderLevel ?? 0))
    .map(i => ({ name: i.name, quantity: i.quantity, reorderLevel: i.reorderLevel ?? 0, unit: i.unit }))

  // Active orders (pending_orders uses restaurantId)
  const activeOrders = await prisma.pendingOrder.count({
    where: { restaurantId, status: { in: ['new', 'in_kitchen'] } },
  })

  // Restaurant name
  const restaurant = await prisma.restaurant.findUnique({ where: { id: restaurantId } })

  const primeCost    = cogs + laborCost
  const primeCostPct = revenue > 0 ? (primeCost / revenue) * 100 : 0

  return NextResponse.json({
    restaurantName: restaurant?.name ?? 'Restaurant',
    period,
    revenue,
    salesCount: sales.length,
    cogs,
    foodCostPct:   Number(foodCostPct.toFixed(1)),
    laborCost,
    laborPct:      Number(laborPct.toFixed(1)),
    wasteCost,
    wastePct:      Number(wastePct.toFixed(1)),
    primeCost,
    primeCostPct:  Number(primeCostPct.toFixed(1)),
    topDishes,
    lowStock,
    activeOrders,
  })
}
