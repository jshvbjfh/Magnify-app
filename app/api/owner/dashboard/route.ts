import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { ensureMainBranchForRestaurant } from '@/lib/restaurantAccess'
import { parseOwnerDashboardRange } from '@/lib/ownerSync'

function toDateKey(date: Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kigali' }).format(date)
}

function formatDayLabel(dateKey: string) {
  return new Intl.DateTimeFormat('en-RW', { month: 'short', day: 'numeric' }).format(new Date(`${dateKey}T12:00:00`))
}

function listDateKeys(from: Date, to: Date) {
  const keys: string[] = []
  const cursor = new Date(from)
  cursor.setUTCHours(0, 0, 0, 0)
  const end = new Date(to)
  end.setUTCHours(0, 0, 0, 0)
  while (cursor <= end) {
    keys.push(toDateKey(cursor))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return keys
}

function ownerDashboardJson(payload: unknown) {
  return NextResponse.json(payload, {
    headers: {
      'Cache-Control': 'private, no-store, max-age=0, must-revalidate',
      Vary: 'Cookie',
    },
  })
}

async function resolveRestaurantAccess(
  requestedRestaurantId: string | null,
  requestedBranchId: string | null,
  userId: string,
  userRole: string,
) {
  let restaurant: { id: string; name: string; ownerId: string } | null = null
  let restaurants: Array<{ id: string; name: string; ownerId: string }> = []

  if (userRole === 'owner' || userRole === 'admin') {
    restaurants = await prisma.restaurant.findMany({
      where: { ownerId: userId, deletedAt: null },
      select: { id: true, name: true, ownerId: true },
      orderBy: { createdAt: 'asc' },
    })

    if (restaurants.length === 0) {
      return { error: NextResponse.json({ error: 'No restaurants linked to this account' }, { status: 403 }) }
    }

    restaurant = requestedRestaurantId
      ? (restaurants.find((r) => r.id === requestedRestaurantId) ?? null)
      : restaurants[0]

    if (!restaurant) {
      return { error: NextResponse.json({ error: 'Restaurant not found' }, { status: 404 }) }
    }
  }

  if (!restaurant) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }

  await ensureMainBranchForRestaurant(restaurant.id)

  const branches = await prisma.branch.findMany({
    where: { restaurantId: restaurant.id, isActive: true },
    orderBy: [{ isMain: 'desc' }, { name: 'asc' }],
    select: { id: true, name: true, code: true, isMain: true },
  })

  let branch = requestedBranchId
    ? (branches.find((b) => b.id === requestedBranchId) ?? null)
    : (branches.find((b) => b.isMain) ?? branches[0] ?? null)

  if (requestedBranchId && !branch) {
    return { error: NextResponse.json({ error: 'Branch not found' }, { status: 404 }) }
  }

  if (!branch) {
    return { error: NextResponse.json({ error: 'No active branch found for this restaurant' }, { status: 400 }) }
  }

  return { restaurant, restaurants, branch, branches }
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const userId = session.user.id
  const userRole = (session.user as any).role ?? 'owner'

  const access = await resolveRestaurantAccess(
    searchParams.get('restaurantId'),
    searchParams.get('branchId'),
    userId,
    userRole,
  )
  if ('error' in access) return access.error

  const { restaurant, restaurants, branch, branches } = access
  const range = parseOwnerDashboardRange(searchParams)

  const branchWhere = { restaurantId: restaurant.id, branchId: branch.id }
  const dateWhere = { gte: range.from, lte: range.to }

  const [
    dishSales,
    wasteLogs,
    journalEntries,
    inventoryItems,
    inventoryPurchases,
    activeOrderCount,
  ] = await Promise.all([
    prisma.dishSale.findMany({
      where: { ...branchWhere, saleDate: dateWhere, deletedAt: null },
      select: {
        id: true,
        dishId: true,
        dishName: true,
        quantitySold: true,
        totalSaleAmount: true,
        calculatedFoodCost: true,
        paymentMethod: true,
        saleDate: true,
      },
      orderBy: { saleDate: 'desc' },
    }),
    prisma.wasteLog.findMany({
      where: { ...branchWhere, date: dateWhere },
      select: { id: true, ingredientId: true, quantityWasted: true, calculatedCost: true, reason: true, date: true },
      orderBy: { date: 'desc' },
    }),
    prisma.journalEntry.findMany({
      where: { restaurantId: restaurant.id, branchId: branch.id, entryDate: dateWhere },
      include: {
        lines: {
          include: { account: { include: { category: true } } },
        },
      },
      orderBy: { entryDate: 'desc' },
      take: 500,
    }),
    prisma.inventoryItem.findMany({
      where: { ...branchWhere, deletedAt: null },
      select: { id: true, name: true, unit: true, quantity: true, unitCost: true, reorderLevel: true },
      orderBy: { name: 'asc' },
    }),
    prisma.inventoryPurchase.findMany({
      where: { ...branchWhere, purchasedAt: dateWhere },
      select: { id: true, ingredientId: true, quantityPurchased: true, totalCost: true, purchasedAt: true, unitCost: true },
      orderBy: { purchasedAt: 'desc' },
      take: 500,
    }),
    prisma.restaurantOrder.count({
      where: { ...branchWhere, status: 'PENDING', deletedAt: null },
    }),
  ])

  // ── Financial summary from journal entries ────────────────────────────────
  let totalRevenue = 0
  let totalExpenses = 0

  const transactionRows: Array<{
    id: string
    date: string
    description: string
    amount: number
    direction: 'in' | 'out'
    accountName: string
    categoryName: string
    categoryType: string
  }> = []

  for (const entry of journalEntries) {
    const drLine = entry.lines.find((l) => l.debit > 0)
    const crLine = entry.lines.find((l) => l.credit > 0)
    const amount = drLine?.debit ?? crLine?.credit ?? 0
    const mainAccount = drLine?.account ?? crLine?.account ?? null
    const categoryType = mainAccount?.category?.type ?? 'expense'

    if (categoryType === 'income') {
      totalRevenue += amount
    } else if (categoryType === 'expense') {
      totalExpenses += amount
    }

    transactionRows.push({
      id: entry.id,
      date: entry.entryDate.toISOString(),
      description: entry.description ?? '',
      amount,
      direction: categoryType === 'income' ? 'in' : 'out',
      accountName: mainAccount?.name ?? '',
      categoryName: mainAccount?.category?.name ?? '',
      categoryType,
    })
  }

  // ── COGS / waste / purchase costs ─────────────────────────────────────────
  const totalCogs = dishSales.reduce((sum, s) => sum + s.calculatedFoodCost, 0)
  const totalWasteCost = wasteLogs.reduce((sum, w) => sum + w.calculatedCost, 0)
  const totalPurchaseCost = inventoryPurchases.reduce((sum, p) => sum + p.totalCost, 0)
  const totalStockValue = inventoryItems.reduce((sum, i) => sum + Number(i.quantity) * Number(i.unitCost), 0)
  const lowStockCount = inventoryItems.filter((i) => Number(i.quantity) <= Number(i.reorderLevel)).length
  const profit = totalRevenue - totalExpenses

  // ── Daily history ──────────────────────────────────────────────────────────
  const dailySalesByDate = new Map<string, { revenue: number; cogs: number }>()
  for (const sale of dishSales) {
    const key = toDateKey(sale.saleDate)
    const current = dailySalesByDate.get(key) ?? { revenue: 0, cogs: 0 }
    current.revenue += sale.totalSaleAmount
    current.cogs += sale.calculatedFoodCost
    dailySalesByDate.set(key, current)
  }
  const dailyExpensesByDate = new Map<string, number>()
  for (const entry of journalEntries) {
    const drLine = entry.lines.find((l) => l.debit > 0)
    const amount = drLine?.debit ?? 0
    const categoryType = drLine?.account?.category?.type
    if (categoryType === 'expense') {
      const key = toDateKey(entry.entryDate)
      dailyExpensesByDate.set(key, (dailyExpensesByDate.get(key) ?? 0) + amount)
    }
  }

  const dailyHistory = listDateKeys(range.from, range.to).map((dateKey) => {
    const sales = dailySalesByDate.get(dateKey) ?? { revenue: 0, cogs: 0 }
    const expenses = dailyExpensesByDate.get(dateKey) ?? 0
    return {
      date: dateKey,
      label: formatDayLabel(dateKey),
      revenue: sales.revenue,
      expenses,
      profit: sales.revenue - expenses,
    }
  })

  // ── Top dishes ─────────────────────────────────────────────────────────────
  const dishTotals = new Map<string, { dishName: string; quantitySold: number; totalRevenue: number }>()
  for (const sale of dishSales) {
    const current = dishTotals.get(sale.dishId) ?? { dishName: sale.dishName, quantitySold: 0, totalRevenue: 0 }
    current.quantitySold += sale.quantitySold
    current.totalRevenue += sale.totalSaleAmount
    dishTotals.set(sale.dishId, current)
  }
  const topDishes = Array.from(dishTotals.values())
    .sort((a, b) => b.totalRevenue - a.totalRevenue)
    .slice(0, 10)

  return ownerDashboardJson({
    restaurantName: restaurant.name,
    selectedRestaurantId: restaurant.id,
    restaurants: restaurants.map((r) => ({ id: r.id, name: r.name })),
    selectedBranchId: branch.id,
    branches: branches.map((b) => ({ id: b.id, name: b.name, code: b.code, isMain: b.isMain })),
    period: range.period,
    rangeLabel: range.label,
    from: range.fromKey,
    to: range.toKey,
    summary: {
      revenue: totalRevenue,
      expenses: totalExpenses,
      profit,
      salesCount: dishSales.length,
      transactionCount: journalEntries.length,
      activeOrders: activeOrderCount,
    },
    costBreakdown: {
      cogs: totalCogs,
      foodCostPct: totalRevenue > 0 ? Number(((totalCogs / totalRevenue) * 100).toFixed(1)) : 0,
      laborCost: 0,
      laborPct: 0,
      wasteCost: totalWasteCost,
      wastePct: totalRevenue > 0 ? Number(((totalWasteCost / totalRevenue) * 100).toFixed(1)) : 0,
      recordedExpenses: totalExpenses,
      primeCost: totalCogs,
      primeCostPct: totalRevenue > 0 ? Number(((totalCogs / totalRevenue) * 100).toFixed(1)) : 0,
    },
    inventory: {
      purchaseCost: totalPurchaseCost,
      stockValue: totalStockValue,
      lowStockCount,
      items: inventoryItems.map((i) => ({
        id: i.id,
        name: i.name,
        unit: i.unit,
        quantity: i.quantity,
        unitCost: i.unitCost,
        reorderLevel: i.reorderLevel,
        isLow: Number(i.quantity) <= Number(i.reorderLevel),
      })),
    },
    transactions: transactionRows,
    dailyHistory,
    topDishes,
  })
}
