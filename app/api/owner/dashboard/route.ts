import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { buildOwnerDashboardPayload, buildOwnerSyncSnapshot, parseOwnerDashboardRange, type OwnerSyncSnapshot } from '@/lib/ownerSync'

function formatDayLabel(dateKey: string) {
  return new Intl.DateTimeFormat('en-RW', { month: 'short', day: 'numeric' }).format(new Date(`${dateKey}T12:00:00`))
}

function toDateKey(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function buildMinimalDashboardPayload(params: {
  restaurantName: string
  selectedRestaurantId: string
  restaurants: Array<{ id: string; name: string }>
  range: ReturnType<typeof parseOwnerDashboardRange>
  saleCount: number
  transactionCount: number
  summaries: Array<{
    date: Date
    totalRevenue: number
    totalExpenses: number
    profitLoss: number
    lastUpdated: Date
  }>
  transactions: Array<{
    id: string
    date: Date
    description: string
    amount: number
    type: string
    paymentMethod: string
    accountName: string | null
    category: { name: string; type: string } | null
    isManual: boolean
  }>
}) {
  const dailyHistory = params.summaries
    .map((row) => {
      const date = toDateKey(row.date)
      return {
        date,
        label: formatDayLabel(date),
        revenue: row.totalRevenue,
        expenses: row.totalExpenses,
        profit: row.profitLoss,
      }
    })
    .sort((a, b) => a.date.localeCompare(b.date))

  const revenue = dailyHistory.reduce((sum, row) => sum + row.revenue, 0)
  const expenses = dailyHistory.reduce((sum, row) => sum + row.expenses, 0)
  const profit = revenue - expenses
  const latestSummaryUpdate = params.summaries.reduce<number | null>((latest, row) => {
    const value = row.lastUpdated.getTime()
    return latest === null ? value : Math.max(latest, value)
  }, null)
  const latestTransaction = params.transactions.reduce<number | null>((latest, row) => {
    const value = row.date.getTime()
    return latest === null ? value : Math.max(latest, value)
  }, null)
  const lastActivityMs = latestSummaryUpdate === null
    ? latestTransaction
    : latestTransaction === null
      ? latestSummaryUpdate
      : Math.max(latestSummaryUpdate, latestTransaction)
  const lastActivityAt = lastActivityMs ? new Date(lastActivityMs) : null

  let statusLevel: 'live' | 'recent' | 'stale' = 'stale'
  let statusLabel = 'Quiet'
  let statusDetail = 'No synced branch activity yet.'

  if (lastActivityAt) {
    const minutesSinceActivity = (Date.now() - lastActivityAt.getTime()) / 60000
    if (minutesSinceActivity <= 5) {
      statusLevel = 'live'
      statusLabel = 'Live now'
      statusDetail = 'New synced branch activity reached the owner cloud in the last few minutes.'
    } else if (minutesSinceActivity <= 60) {
      statusLevel = 'recent'
      statusLabel = 'Recently active'
      statusDetail = 'The branch synced recently, but nothing new has arrived in the last few minutes.'
    } else {
      statusDetail = 'No recent sync activity has reached the owner cloud for a while.'
    }
  }

  return {
    restaurantName: params.restaurantName,
    selectedRestaurantId: params.selectedRestaurantId,
    restaurants: params.restaurants,
    period: params.range.period,
    rangeLabel: params.range.label,
    from: params.range.fromKey,
    to: params.range.toKey,
    sync: {
      source: 'minimal' as const,
      generatedAt: lastActivityAt?.toISOString() ?? new Date().toISOString(),
    },
    summary: {
      revenue,
      expenses,
      profit,
      salesCount: params.saleCount,
      transactionCount: params.transactionCount,
      activeOrders: 0,
    },
    costBreakdown: {
      cogs: 0,
      foodCostPct: 0,
      laborCost: 0,
      laborPct: 0,
      wasteCost: 0,
      wastePct: 0,
      recordedExpenses: expenses,
      primeCost: 0,
      primeCostPct: 0,
    },
    status: {
      level: statusLevel,
      label: statusLabel,
      detail: statusDetail,
      lastActivityAt: lastActivityAt?.toISOString() ?? null,
      activeOrders: 0,
    },
    transactions: params.transactions.map((txn) => ({
      id: txn.id,
      date: txn.date.toISOString(),
      description: txn.description,
      amount: txn.amount,
      type: txn.type,
      paymentMethod: txn.paymentMethod,
      accountName: txn.accountName ?? '',
      categoryName: txn.category?.name ?? '',
      categoryType: txn.category?.type ?? '',
      isManual: txn.isManual,
    })),
    dailyHistory,
    topDishes: [],
    lowStock: [],
    inventory: {
      purchaseCost: 0,
      usedCost: 0,
      stockValue: 0,
      lowStockCount: 0,
      items: [],
    },
  }
}

async function resolveRestaurantAccess(requestedRestaurantId: string | null) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const userRole = (session.user as any).role
  const userId = session.user.id

  if (userRole === 'owner') {
    const restaurants = await prisma.restaurant.findMany({
      where: { ownerId: userId },
      select: { id: true, name: true, ownerId: true },
      orderBy: { createdAt: 'asc' },
    })

    if (restaurants.length === 0) {
      const restaurantId = (session.user as any).restaurantId
      if (!restaurantId) {
        return { error: NextResponse.json({ error: 'No restaurants linked to this owner account' }, { status: 403 }) }
      }

      const linkedRestaurant = await prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: { id: true, name: true, ownerId: true },
      })

      if (!linkedRestaurant) return { error: NextResponse.json({ error: 'Restaurant not found' }, { status: 404 }) }
      return { restaurant: linkedRestaurant, restaurants: [linkedRestaurant] }
    }

    const restaurant = requestedRestaurantId
      ? restaurants.find((row) => row.id === requestedRestaurantId) ?? null
      : restaurants[0]

    if (!restaurant) return { error: NextResponse.json({ error: 'Restaurant not found' }, { status: 404 }) }
    return { restaurant, restaurants }
  }

  if (userRole === 'admin') {
    const restaurant = await prisma.restaurant.findFirst({
      where: { ownerId: userId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, ownerId: true },
    })

    if (!restaurant) return { error: NextResponse.json({ error: 'Restaurant not set up yet' }, { status: 404 }) }
    return { restaurant, restaurants: [{ id: restaurant.id, name: restaurant.name, ownerId: restaurant.ownerId }] }
  }

  return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const access = await resolveRestaurantAccess(searchParams.get('restaurantId'))
  if ('error' in access) return access.error

  const { restaurant, restaurants } = access
  const managerUserId = restaurant.ownerId
  const range = parseOwnerDashboardRange(searchParams)

  const syncedWhere = {
    restaurantId: restaurant.id,
    synced: true,
    date: { gte: range.from, lte: range.to },
  }

  const [syncedSummaries, syncedTransactions, syncedTransactionCount, syncedSaleCount] = await Promise.all([
    prisma.dailySummary.findMany({
      where: {
        restaurantId: restaurant.id,
        synced: true,
        date: { gte: range.from, lte: range.to },
      },
      orderBy: { date: 'asc' },
    }),
    prisma.transaction.findMany({
      where: syncedWhere,
      include: {
        category: { select: { name: true, type: true } },
      },
      orderBy: { date: 'desc' },
      take: 20,
    }),
    prisma.transaction.count({
      where: syncedWhere,
    }),
    prisma.transaction.count({
      where: {
        ...syncedWhere,
        category: { is: { type: 'income' } },
      },
    }),
  ])

  if (syncedSummaries.length > 0 || syncedTransactions.length > 0) {
    return NextResponse.json(
      buildMinimalDashboardPayload({
        restaurantName: restaurant.name,
        selectedRestaurantId: restaurant.id,
        restaurants: restaurants.map((row) => ({ id: row.id, name: row.name })),
        range,
        saleCount: syncedSaleCount,
        transactionCount: syncedTransactionCount,
        summaries: syncedSummaries,
        transactions: syncedTransactions,
      })
    )
  }

  const syncedSnapshot = await prisma.financialStatement.findFirst({
    where: { type: `owner_sync_snapshot:${restaurant.id}` },
    orderBy: { updatedAt: 'desc' },
  })

  if (syncedSnapshot?.data) {
    try {
      const snapshot = JSON.parse(syncedSnapshot.data) as OwnerSyncSnapshot
      if (snapshot?.version === 1 && snapshot.restaurantId === restaurant.id) {
        return NextResponse.json({
          ...buildOwnerDashboardPayload(snapshot, range, 'snapshot'),
          selectedRestaurantId: restaurant.id,
          restaurants: restaurants.map((row) => ({ id: row.id, name: row.name })),
        })
      }
    } catch {
      // Fall back to live cloud data if the snapshot payload is malformed.
    }
  }

  const [
    sales,
    shifts,
    wasteLogs,
    expenseTransactions,
    transactions,
    ingredients,
    purchases,
    ingredientUsage,
    activeOrders,
    latestSale,
    latestTransaction,
    latestPendingOrder,
    latestPurchase,
    latestWaste,
  ] = await Promise.all([
    prisma.dishSale.findMany({
      where: { userId: managerUserId },
      include: { dish: { select: { name: true } } },
      orderBy: { saleDate: 'desc' },
      take: 5000,
    }),
    prisma.shift.findMany({
      where: { userId: managerUserId },
      orderBy: { date: 'desc' },
      take: 2000,
    }),
    prisma.wasteLog.findMany({
      where: { userId: managerUserId },
      orderBy: { date: 'desc' },
      take: 2000,
    }),
    prisma.transaction.findMany({
      where: {
        userId: managerUserId,
        category: { is: { type: 'expense' } },
      },
      include: {
        account: { select: { name: true } },
        category: { select: { name: true, type: true } },
      },
      orderBy: { date: 'desc' },
      take: 4000,
    }),
    prisma.transaction.findMany({
      where: { userId: managerUserId },
      include: {
        account: { select: { name: true } },
        category: { select: { name: true, type: true } },
      },
      orderBy: { date: 'desc' },
      take: 1000,
    }),
    prisma.inventoryItem.findMany({
      where: { userId: managerUserId, inventoryType: 'ingredient' },
      orderBy: { name: 'asc' },
    }),
    prisma.inventoryPurchase.findMany({
      where: { userId: managerUserId },
      orderBy: { purchasedAt: 'desc' },
      take: 3000,
    }),
    prisma.dishSaleIngredient.findMany({
      where: { dishSale: { userId: managerUserId } },
      include: { dishSale: { select: { saleDate: true } } },
      take: 5000,
    }),
    prisma.pendingOrder.count({
      where: { restaurantId: restaurant.id, status: { in: ['new', 'in_kitchen'] } },
    }),
    prisma.dishSale.findFirst({ where: { userId: managerUserId }, orderBy: { saleDate: 'desc' }, select: { saleDate: true } }),
    prisma.transaction.findFirst({ where: { userId: managerUserId }, orderBy: { date: 'desc' }, select: { date: true } }),
    prisma.pendingOrder.findFirst({ where: { restaurantId: restaurant.id }, orderBy: { addedAt: 'desc' }, select: { addedAt: true } }),
    prisma.inventoryPurchase.findFirst({ where: { userId: managerUserId }, orderBy: { purchasedAt: 'desc' }, select: { purchasedAt: true } }),
    prisma.wasteLog.findFirst({ where: { userId: managerUserId }, orderBy: { date: 'desc' }, select: { date: true } }),
  ])

  const snapshot = buildOwnerSyncSnapshot({
    restaurantId: restaurant.id,
    restaurantName: restaurant.name,
    activeOrders,
    sales,
    shifts,
    wasteLogs,
    expenseTransactions,
    transactions,
    ingredients,
    purchases,
    ingredientUsage,
    activity: {
      lastSaleAt: latestSale?.saleDate ?? null,
      lastTransactionAt: latestTransaction?.date ?? null,
      lastPendingOrderAt: latestPendingOrder?.addedAt ?? null,
      lastPurchaseAt: latestPurchase?.purchasedAt ?? null,
      lastWasteAt: latestWaste?.date ?? null,
    },
  })

  return NextResponse.json({
    ...buildOwnerDashboardPayload(snapshot, range, 'live'),
    selectedRestaurantId: restaurant.id,
    restaurants: restaurants.map((row) => ({ id: row.id, name: row.name })),
  })
}
