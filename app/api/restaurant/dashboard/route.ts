import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

function startOf(period: 'today' | 'week' | 'month'): Date {
  const now = new Date()
  if (period === 'today') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate())
  } else if (period === 'week') {
    const d = new Date(now)
    d.setDate(d.getDate() - 6)
    d.setHours(0, 0, 0, 0)
    return d
  } else {
    return new Date(now.getFullYear(), now.getMonth(), 1)
  }
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const period = (searchParams.get('period') ?? 'today') as 'today' | 'week' | 'month'

  const from = startOf(period)
  const to = new Date()

  // Revenue & Food Cost from dish sales
  const sales = await prisma.dishSale.findMany({
    where: { userId: session.user.id, saleDate: { gte: from, lte: to } },
    include: { dish: true }
  })

  const revenue = sales.reduce((s: number, x) => s + (x.totalSaleAmount ?? 0), 0)
  const cogs = sales.reduce((s: number, x) => s + (x.calculatedFoodCost ?? 0), 0)
  const foodCostPct = revenue > 0 ? (cogs / revenue) * 100 : 0

  // Labor cost from shifts
  const shifts = await prisma.shift.findMany({
    where: { userId: session.user.id, date: { gte: from, lte: to } }
  })
  const laborCost = shifts.reduce((s: number, x) => s + (x.calculatedWage ?? 0), 0)
  const laborPct = revenue > 0 ? (laborCost / revenue) * 100 : 0

  // Waste cost
  const wasteLogs = await prisma.wasteLog.findMany({
    where: { userId: session.user.id, date: { gte: from, lte: to } }
  })
  const wasteCost = wasteLogs.reduce((s: number, x) => s + (x.calculatedCost ?? 0), 0)
  const wastePct = revenue > 0 ? (wasteCost / revenue) * 100 : 0

  // Prime cost = COGS + Labor
  const primeCost = cogs + laborCost
  const primeCostPct = revenue > 0 ? (primeCost / revenue) * 100 : 0

  // Top dishes
  const dishMap: Record<string, { name: string; revenue: number; orders: number }> = {}
  for (const s of sales) {
    const key = s.dishId
    if (!dishMap[key]) dishMap[key] = { name: s.dish.name, revenue: 0, orders: 0 }
    dishMap[key].revenue += s.totalSaleAmount
    dishMap[key].orders += s.quantitySold
  }
  const topDishes = Object.values(dishMap)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5)

  // Low stock count
  const allIngredients = await prisma.inventoryItem.findMany({
    where: { userId: session.user.id, inventoryType: 'ingredient' }
  })
  const lowStockCount = allIngredients.filter(i => i.quantity <= (i.reorderLevel ?? 0)).length

  // Alerts
  const alerts: { type: 'warning' | 'danger'; message: string }[] = []
  if (primeCostPct > 65) alerts.push({ type: 'danger', message: `Prime Cost at ${primeCostPct.toFixed(1)}% — critically high (target <60%)` })
  else if (primeCostPct > 60) alerts.push({ type: 'warning', message: `Prime Cost at ${primeCostPct.toFixed(1)}% — above target (target <60%)` })
  if (wastePct > 5) alerts.push({ type: 'warning', message: `Waste at ${wastePct.toFixed(1)}% of revenue — investigate losses` })
  if (foodCostPct > 35) alerts.push({ type: 'warning', message: `Food Cost at ${foodCostPct.toFixed(1)}% — above 35% target` })

  return NextResponse.json({
    period,
    revenue,
    cogs,
    foodCostPct: Number(foodCostPct.toFixed(1)),
    laborCost,
    laborPct: Number(laborPct.toFixed(1)),
    wasteCost,
    wastePct: Number(wastePct.toFixed(1)),
    primeCost,
    primeCostPct: Number(primeCostPct.toFixed(1)),
    topDishes,
    lowStockCount,
    alerts,
    salesCount: sales.length,
  })
}
