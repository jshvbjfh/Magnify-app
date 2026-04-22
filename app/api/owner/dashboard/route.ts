import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { buildOwnerDashboardPayload, buildOwnerSyncSnapshot, parseOwnerDashboardRange, type OwnerSyncSnapshot } from '@/lib/ownerSync'
import { ensureMainBranchForRestaurant } from '@/lib/restaurantAccess'

const ownerBranchSelect = {
  id: true,
  name: true,
  code: true,
  isMain: true,
  isActive: true,
  sortOrder: true,
} as const

type HomeActivityOrder = {
  id: string
  createdAt: Date
  tableId: string | null
  tableName: string
  createdByName: string
}

function formatDayLabel(dateKey: string) {
  return new Intl.DateTimeFormat('en-RW', { month: 'short', day: 'numeric' }).format(new Date(`${dateKey}T12:00:00`))
}

function toDateKey(date: Date) {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
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

function getClientKey(order: HomeActivityOrder) {
  const guestMatch = order.createdByName.match(/^Guest\s*-\s*(.+)$/i)
  const guestName = guestMatch?.[1]?.trim()

  if (guestName) return `guest:${guestName.toLowerCase()}`
  if (order.tableId) return `table:${order.tableId}`

  const tableName = order.tableName.trim()
  if (tableName && tableName.toLowerCase() !== 'takeaway') {
    return `table-name:${tableName.toLowerCase()}`
  }

  const creator = order.createdByName.trim()
  if (creator && creator.toLowerCase() !== 'staff') {
    return `staff:${creator.toLowerCase()}`
  }

  return `order:${order.id}`
}

function isWasteLikeTransaction(entry: { sourceKind?: string | null; description: string }) {
  const normalizedSourceKind = String(entry.sourceKind || '').trim().toLowerCase()
  if (normalizedSourceKind === 'inventory_waste') return true
  return entry.description.trim().toLowerCase().startsWith('waste:')
}

function buildBranchScopeWhere(branch: { id: string; isMain: boolean }) {
  return branch.isMain
    ? { OR: [{ branchId: branch.id }, { branchId: null }] }
    : { branchId: branch.id }
}

async function listActiveBranches(restaurantId: string) {
  return prisma.restaurantBranch.findMany({
    where: { restaurantId, isActive: true },
    orderBy: [
      { isMain: 'desc' },
      { sortOrder: 'asc' },
      { name: 'asc' },
    ],
    select: ownerBranchSelect,
  })
}

function withHomeMetrics<T extends {
  summary: Record<string, unknown>
  dailyHistory: Array<{
    date: string
    label: string
    revenue: number
    expenses: number
    profit: number
  }>
}>(payload: T, orders: HomeActivityOrder[], range: ReturnType<typeof parseOwnerDashboardRange>) {
  const dailyCounts = new Map<string, { orderCount: number; clientKeys: Set<string> }>()
  const totalClientKeys = new Set<string>()

  for (const order of orders) {
    const dateKey = toDateKey(order.createdAt)
    const current = dailyCounts.get(dateKey) ?? { orderCount: 0, clientKeys: new Set<string>() }
    const clientKey = getClientKey(order)

    current.orderCount += 1
    current.clientKeys.add(clientKey)
    totalClientKeys.add(clientKey)
    dailyCounts.set(dateKey, current)
  }

  const historyByDate = new Map(payload.dailyHistory.map((day) => [day.date, day]))
  const dailyHistory = listDateKeys(range.from, range.to).map((dateKey) => {
    const baseDay = historyByDate.get(dateKey) ?? {
      date: dateKey,
      label: formatDayLabel(dateKey),
      revenue: 0,
      expenses: 0,
      profit: 0,
    }
    const counts = dailyCounts.get(dateKey)

    return {
      ...baseDay,
      orderCount: counts?.orderCount ?? 0,
      clientCount: counts?.clientKeys.size ?? 0,
    }
  })

  return {
    ...payload,
    summary: {
      ...payload.summary,
      orderCount: orders.length,
      clientCount: totalClientKeys.size,
    },
    dailyHistory,
  }
}

function buildMinimalDashboardPayload(params: {
  restaurantName: string
  selectedRestaurantId: string
  restaurants: Array<{ id: string; name: string }>
  selectedBranchId: string
  branches: Array<{ id: string; name: string; code: string; isMain: boolean }>
  range: ReturnType<typeof parseOwnerDashboardRange>
  saleCount: number
  transactionCount: number
  wasteCost: number
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
    sourceKind: string | null
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
    selectedBranchId: params.selectedBranchId,
    branches: params.branches,
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
      wasteCost: params.wasteCost,
      wastePct: revenue > 0 ? Number(((params.wasteCost / revenue) * 100).toFixed(1)) : 0,
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
      sourceKind: txn.sourceKind,
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

async function resolveRestaurantAccess(requestedRestaurantId: string | null, requestedBranchId: string | null) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const userRole = (session.user as any).role
  const userId = session.user.id
  const currentUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, restaurantId: true, branchId: true },
  })

  let restaurant: { id: string; name: string; ownerId: string } | null = null
  let restaurants: Array<{ id: string; name: string; ownerId: string }> = []

  if (userRole === 'owner') {
    restaurants = await prisma.restaurant.findMany({
      where: { ownerId: userId },
      select: { id: true, name: true, ownerId: true },
      orderBy: { createdAt: 'asc' },
    })

    if (restaurants.length === 0) {
      const restaurantId = currentUser?.restaurantId ?? (session.user as any).restaurantId
      if (!restaurantId) {
        return { error: NextResponse.json({ error: 'No restaurants linked to this owner account' }, { status: 403 }) }
      }

      const linkedRestaurant = await prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: { id: true, name: true, ownerId: true },
      })

      if (!linkedRestaurant) return { error: NextResponse.json({ error: 'Restaurant not found' }, { status: 404 }) }
      restaurant = linkedRestaurant
      restaurants = [linkedRestaurant]
    } else {
      restaurant = requestedRestaurantId
        ? restaurants.find((row) => row.id === requestedRestaurantId) ?? null
        : restaurants[0]
    }
  }

  if (!restaurant && userRole === 'admin') {
    restaurant = await prisma.restaurant.findFirst({
      where: { ownerId: userId },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, ownerId: true },
    })

    if (!restaurant) return { error: NextResponse.json({ error: 'Restaurant not set up yet' }, { status: 404 }) }
    restaurants = [{ id: restaurant.id, name: restaurant.name, ownerId: restaurant.ownerId }]
  }

  if (!restaurant) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
  }

  await ensureMainBranchForRestaurant(restaurant.id)
  const branches = await listActiveBranches(restaurant.id)
  const normalizedRequestedBranchId = String(requestedBranchId ?? '').trim()
  let branch = normalizedRequestedBranchId
    ? branches.find((row) => row.id === normalizedRequestedBranchId) ?? null
    : branches.find((row) => row.id === currentUser?.branchId) ?? branches[0] ?? null

  if (normalizedRequestedBranchId && !branch) {
    return { error: NextResponse.json({ error: 'Branch not found' }, { status: 404 }) }
  }

  if (!branch) {
    return { error: NextResponse.json({ error: 'No active branch found for this restaurant' }, { status: 400 }) }
  }

  if (currentUser?.branchId !== branch.id) {
    await prisma.user.update({
      where: { id: userId },
      data: { branchId: branch.id },
    })
  }

  return { restaurant, restaurants, branch, branches }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const includeFullTransactionHistory = searchParams.get('transactionHistory') === 'full'
  const access = await resolveRestaurantAccess(searchParams.get('restaurantId'), searchParams.get('branchId'))
  if ('error' in access) return access.error

  const { restaurant, restaurants, branch, branches } = access
  const range = parseOwnerDashboardRange(searchParams)
  const branchScopeWhere = buildBranchScopeWhere(branch)

  const syncedWhere = {
    restaurantId: restaurant.id,
    ...branchScopeWhere,
    synced: true,
    date: { gte: range.from, lte: range.to },
  }

  const [homeActivityOrders, syncedSummaries, syncedTransactions, syncedTransactionCount, syncedSaleCount, syncedWasteAggregate] = await Promise.all([
    prisma.restaurantOrder.findMany({
      where: {
        restaurantId: restaurant.id,
        ...branchScopeWhere,
        status: { not: 'CANCELED' },
        createdAt: { gte: range.from, lte: range.to },
      },
      select: {
        id: true,
        createdAt: true,
        tableId: true,
        tableName: true,
        createdByName: true,
      },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.dailySummary.findMany({
      where: {
        restaurantId: restaurant.id,
        ...branchScopeWhere,
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
      ...(includeFullTransactionHistory ? {} : { take: 20 }),
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
    prisma.transaction.aggregate({
      where: {
        ...syncedWhere,
        type: 'debit',
        OR: [
          { sourceKind: 'inventory_waste' },
          { description: { startsWith: 'Waste:' } },
        ],
      },
      _sum: { amount: true },
    }),
  ])

  if (syncedSummaries.length > 0 || syncedTransactions.length > 0) {
    return NextResponse.json(
      withHomeMetrics(buildMinimalDashboardPayload({
        restaurantName: restaurant.name,
        selectedRestaurantId: restaurant.id,
        restaurants: restaurants.map((row) => ({ id: row.id, name: row.name })),
        selectedBranchId: branch.id,
        branches: branches.map((row) => ({ id: row.id, name: row.name, code: row.code, isMain: row.isMain })),
        range,
        saleCount: syncedSaleCount,
        transactionCount: syncedTransactionCount,
        wasteCost: syncedWasteAggregate._sum.amount ?? 0,
        summaries: syncedSummaries,
        transactions: syncedTransactions,
      }), homeActivityOrders, range)
    )
  }

  const syncedSnapshot = await prisma.financialStatement.findFirst({
    where: { type: `owner_sync_snapshot:${restaurant.id}:${branch.id}` },
    orderBy: { updatedAt: 'desc' },
  })

  if (syncedSnapshot?.data) {
    try {
      const snapshot = JSON.parse(syncedSnapshot.data) as OwnerSyncSnapshot
      if (snapshot?.version === 1 && snapshot.restaurantId === restaurant.id) {
        return NextResponse.json({
          ...withHomeMetrics(buildOwnerDashboardPayload(snapshot, range, 'snapshot', { includeFullTransactionHistory }), homeActivityOrders, range),
          selectedRestaurantId: restaurant.id,
          restaurants: restaurants.map((row) => ({ id: row.id, name: row.name })),
          selectedBranchId: branch.id,
          branches: branches.map((row) => ({ id: row.id, name: row.name, code: row.code, isMain: row.isMain })),
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
      where: {
        restaurantId: restaurant.id,
        ...branchScopeWhere,
      },
      include: { dish: { select: { name: true } } },
      orderBy: { saleDate: 'desc' },
      take: 5000,
    }),
    prisma.shift.findMany({
      where: {
        restaurantId: restaurant.id,
        ...branchScopeWhere,
      },
      orderBy: { date: 'desc' },
      take: 2000,
    }),
    prisma.wasteLog.findMany({
      where: {
        restaurantId: restaurant.id,
        ...branchScopeWhere,
      },
      orderBy: { date: 'desc' },
      take: 2000,
    }),
    prisma.transaction.findMany({
      where: {
        restaurantId: restaurant.id,
        ...branchScopeWhere,
        category: { is: { type: 'expense' } },
        NOT: [
          {
            description: {
              startsWith: 'COGS - ',
            },
          },
          {
            sourceKind: 'inventory_waste',
          },
        ],
      },
      include: {
        account: { select: { name: true } },
        category: { select: { name: true, type: true } },
      },
      orderBy: { date: 'desc' },
      take: 4000,
    }),
    prisma.transaction.findMany({
      where: {
        restaurantId: restaurant.id,
        ...branchScopeWhere,
      },
      include: {
        account: { select: { name: true } },
        category: { select: { name: true, type: true } },
      },
      orderBy: { date: 'desc' },
      take: 1000,
    }),
    prisma.inventoryItem.findMany({
      where: {
        restaurantId: restaurant.id,
        ...branchScopeWhere,
        inventoryType: 'ingredient',
      },
      orderBy: { name: 'asc' },
    }),
    prisma.inventoryPurchase.findMany({
      where: {
        restaurantId: restaurant.id,
        ...branchScopeWhere,
      },
      orderBy: { purchasedAt: 'desc' },
      take: 3000,
    }),
    prisma.dishSaleIngredient.findMany({
      where: {
        dishSale: {
          restaurantId: restaurant.id,
          ...branchScopeWhere,
        },
      },
      include: { dishSale: { select: { saleDate: true } } },
      take: 5000,
    }),
    prisma.pendingOrder.count({
      where: { restaurantId: restaurant.id, ...branchScopeWhere, status: { in: ['new', 'in_kitchen'] } },
    }),
    prisma.dishSale.findFirst({ where: { restaurantId: restaurant.id, ...branchScopeWhere }, orderBy: { saleDate: 'desc' }, select: { saleDate: true } }),
    prisma.transaction.findFirst({ where: { restaurantId: restaurant.id, ...branchScopeWhere }, orderBy: { date: 'desc' }, select: { date: true } }),
    prisma.pendingOrder.findFirst({ where: { restaurantId: restaurant.id, ...branchScopeWhere }, orderBy: { addedAt: 'desc' }, select: { addedAt: true } }),
    prisma.inventoryPurchase.findFirst({ where: { restaurantId: restaurant.id, ...branchScopeWhere }, orderBy: { purchasedAt: 'desc' }, select: { purchasedAt: true } }),
    prisma.wasteLog.findFirst({ where: { restaurantId: restaurant.id, ...branchScopeWhere }, orderBy: { date: 'desc' }, select: { date: true } }),
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
    ...withHomeMetrics(buildOwnerDashboardPayload(snapshot, range, 'live', { includeFullTransactionHistory }), homeActivityOrders, range),
    selectedRestaurantId: restaurant.id,
    restaurants: restaurants.map((row) => ({ id: row.id, name: row.name })),
    selectedBranchId: branch.id,
    branches: branches.map((row) => ({ id: row.id, name: row.name, code: row.code, isMain: row.isMain })),
  })
}
