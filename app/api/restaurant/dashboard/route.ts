import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { cached } from '@/lib/apiCache'

function toDateKey(date: Date) {
  // Africa/Kigali = UTC+2; prevents early-morning sales being pushed to the previous UTC day
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali' }).format(date)
}

function parseDateParam(value: string | null) {
  if (!value) return null
  const parsed = new Date(`${value}T00:00:00+02:00`) // midnight Kigali time
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function endOfDate(date: Date) {
  // date is already at Kigali midnight; add a full day minus 1ms to cover the entire Kigali day
  return new Date(date.getTime() + 86400000 - 1)
}

function formatRangeLabel(from: Date, to: Date) {
  const formatter = new Intl.DateTimeFormat('en-RW', { month: 'short', day: 'numeric', year: 'numeric' })
  return `${formatter.format(from)} - ${formatter.format(to)}`
}

function formatPresetRangeLabel(period: 'today' | 'week' | 'month' | 'quarter' | 'year') {
  if (period === 'today') return 'Today'
  if (period === 'week') return 'Last 7 Days'
  if (period === 'month') return 'This Month'
  if (period === 'quarter') return 'This Quarter'
  return 'This Year'
}

function startOf(period: 'today' | 'week' | 'month' | 'quarter' | 'year'): Date {
  const todayKigali = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali' }).format(new Date())
  const [year, monthStr] = todayKigali.split('-')
  if (period === 'today') return new Date(`${todayKigali}T00:00:00+02:00`)
  if (period === 'week') {
    const d = new Date(`${todayKigali}T00:00:00+02:00`)
    d.setUTCDate(d.getUTCDate() - 6)
    return d
  }
  if (period === 'month') return new Date(`${year}-${monthStr}-01T00:00:00+02:00`)
  if (period === 'quarter') {
    const q = Math.floor((parseInt(monthStr) - 1) / 3) * 3 + 1
    return new Date(`${year}-${String(q).padStart(2, '0')}-01T00:00:00+02:00`)
  }
  return new Date(`${year}-01-01T00:00:00+02:00`)
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null
  if (!restaurantId || !branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { createdAt: true },
  })

  const { searchParams } = new URL(req.url)
  const rawPeriod = searchParams.get('period') ?? 'today'
  const period = ['today', 'week', 'month', 'quarter', 'year'].includes(rawPeriod)
    ? (rawPeriod as 'today' | 'week' | 'month' | 'quarter' | 'year')
    : 'today'
  const fromParam = parseDateParam(searchParams.get('from'))
  const toParam = parseDateParam(searchParams.get('to'))
  const hasCustomRange = Boolean(fromParam && toParam)

  const accountStart = user?.createdAt ? new Date(user.createdAt) : null
  if (accountStart) accountStart.setHours(0, 0, 0, 0)

  const from = hasCustomRange ? fromParam! : startOf(period)
  const to = hasCustomRange ? endOfDate(toParam!) : new Date()
  if (accountStart && from < accountStart) from.setTime(accountStart.getTime())
  const rangeLabel = hasCustomRange ? formatRangeLabel(from, to) : formatPresetRangeLabel(period)

  // Revenue & Food Cost from dish sales
  const incomeTransactions: { date: Date; amount: number; type: string }[] = []
  const sales = await prisma.dishSale.findMany({
    where: { restaurantId, branchId, saleDate: { gte: from, lte: to } },
    include: { dish: true },
  })

  const revenue = sales.reduce((s: number, x) => s + (x.totalSaleAmount ?? 0), 0)
    + incomeTransactions.reduce((sum, txn) => sum + (txn.type === 'credit' ? txn.amount : -txn.amount), 0)
  const cogs = sales.reduce((s: number, x) => s + (x.calculatedFoodCost ?? 0), 0)
  const foodCostPct = revenue > 0 ? (cogs / revenue) * 100 : 0

  const shifts: { date: Date; calculatedWage: number | null }[] = []
  const laborCost = 0
  const laborPct = revenue > 0 ? (laborCost / revenue) * 100 : 0

  // Waste cost
  const wasteLogs = await prisma.wasteLog.findMany({
    where: {
      restaurantId,
      branchId,
      date: { gte: from, lte: to }
    }
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

  const dayMap = new Map<string, {
    revenue: number
    salesCount: number
    cogs: number
    laborCost: number
    wasteCost: number
  }>()
  for (const sale of sales) {
    const key = toDateKey(new Date(sale.saleDate))
    const current = dayMap.get(key) ?? { revenue: 0, salesCount: 0, cogs: 0, laborCost: 0, wasteCost: 0 }
    current.revenue += sale.totalSaleAmount ?? 0
    current.salesCount += 1
    current.cogs += sale.calculatedFoodCost ?? 0
    dayMap.set(key, current)
  }

  for (const txn of incomeTransactions) {
    const key = toDateKey(new Date(txn.date))
    const current = dayMap.get(key) ?? { revenue: 0, salesCount: 0, cogs: 0, laborCost: 0, wasteCost: 0 }
    current.revenue += txn.type === 'credit' ? txn.amount : -txn.amount
    dayMap.set(key, current)
  }

  for (const shift of shifts) {
    const key = toDateKey(new Date(shift.date))
    const current = dayMap.get(key) ?? { revenue: 0, salesCount: 0, cogs: 0, laborCost: 0, wasteCost: 0 }
    current.laborCost += shift.calculatedWage ?? 0
    dayMap.set(key, current)
  }

  for (const wasteLog of wasteLogs) {
    const key = toDateKey(new Date(wasteLog.date))
    const current = dayMap.get(key) ?? { revenue: 0, salesCount: 0, cogs: 0, laborCost: 0, wasteCost: 0 }
    current.wasteCost += wasteLog.calculatedCost ?? 0
    dayMap.set(key, current)
  }

  const dailyHistory: Array<{
    date: string
    revenue: number
    salesCount: number
    cogs: number
    foodCostPct: number
    laborCost: number
    laborPct: number
    wasteCost: number
    wastePct: number
    primeCost: number
    primeCostPct: number
  }> = []
  const cursor = new Date(from)
  cursor.setHours(0, 0, 0, 0)
  const rangeEnd = new Date(to)
  rangeEnd.setHours(0, 0, 0, 0)
  while (cursor <= rangeEnd) {
    const key = toDateKey(cursor)
    const current = dayMap.get(key) ?? { revenue: 0, salesCount: 0, cogs: 0, laborCost: 0, wasteCost: 0 }
    const dailyFoodCostPct = current.revenue > 0 ? (current.cogs / current.revenue) * 100 : 0
    const dailyLaborPct = current.revenue > 0 ? (current.laborCost / current.revenue) * 100 : 0
    const dailyWastePct = current.revenue > 0 ? (current.wasteCost / current.revenue) * 100 : 0
    const dailyPrimeCost = current.cogs + current.laborCost
    const dailyPrimeCostPct = current.revenue > 0 ? (dailyPrimeCost / current.revenue) * 100 : 0
    dailyHistory.push({
      date: key,
      revenue: current.revenue,
      salesCount: current.salesCount,
      cogs: current.cogs,
      foodCostPct: Number(dailyFoodCostPct.toFixed(1)),
      laborCost: current.laborCost,
      laborPct: Number(dailyLaborPct.toFixed(1)),
      wasteCost: current.wasteCost,
      wastePct: Number(dailyWastePct.toFixed(1)),
      primeCost: dailyPrimeCost,
      primeCostPct: Number(dailyPrimeCostPct.toFixed(1)),
    })
    cursor.setDate(cursor.getDate() + 1)
  }

  // Low stock count
  const allIngredients = await prisma.inventoryItem.findMany({
    where: { restaurantId, branchId },
  })
  const lowStockCount = allIngredients.filter(i => i.quantity <= (i.reorderLevel ?? 0)).length

  // Alerts
  const alerts: { type: 'warning' | 'danger'; message: string }[] = []
  if (primeCostPct > 65) alerts.push({ type: 'danger', message: `Prime Cost at ${primeCostPct.toFixed(1)}% — critically high (target <60%)` })
  else if (primeCostPct > 60) alerts.push({ type: 'warning', message: `Prime Cost at ${primeCostPct.toFixed(1)}% — above target (target <60%)` })
  if (wastePct > 5) alerts.push({ type: 'warning', message: `Waste at ${wastePct.toFixed(1)}% of revenue — investigate losses` })
  if (foodCostPct > 35) alerts.push({ type: 'warning', message: `Food Cost at ${foodCostPct.toFixed(1)}% — above 35% target` })

  return cached({
    period: hasCustomRange ? 'custom' : period,
    from: toDateKey(from),
    to: toDateKey(to),
    rangeLabel,
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
    dailyHistory,
  }, 60)
}
