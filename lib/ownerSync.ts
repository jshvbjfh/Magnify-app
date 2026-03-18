type Period = 'today' | 'week' | 'month'

export type OwnerDashboardRange = {
  period: Period | 'custom'
  from: Date
  to: Date
  fromKey: string
  toKey: string
  label: string
}

export type OwnerSyncSnapshot = {
  version: 1
  restaurantId: string
  restaurantName: string
  generatedAt: string
  activeOrders: number
  activity: {
    lastSaleAt: string | null
    lastTransactionAt: string | null
    lastPendingOrderAt: string | null
    lastPurchaseAt: string | null
    lastWasteAt: string | null
  }
  sales: Array<{
    date: string
    dishId: string
    dishName: string
    quantitySold: number
    totalSaleAmount: number
    calculatedFoodCost: number
  }>
  shifts: Array<{
    date: string
    calculatedWage: number
  }>
  wasteLogs: Array<{
    date: string
    calculatedCost: number
  }>
  expenseTransactions: Array<{
    date: string
    amount: number
    type: string
  }>
  transactions: Array<{
    id: string
    date: string
    description: string
    amount: number
    type: string
    paymentMethod: string
    accountName: string
    categoryName: string
    categoryType: string
    isManual: boolean
  }>
  ingredients: Array<{
    id: string
    name: string
    unit: string
    quantity: number
    unitCost: number
    reorderLevel: number
  }>
  purchases: Array<{
    ingredientId: string
    quantityPurchased: number
    totalCost: number
    purchasedAt: string
  }>
  ingredientUsage: Array<{
    ingredientId: string
    quantityUsed: number
    actualCost: number
    saleDate: string
  }>
}

function startOf(period: Period) {
  const now = new Date()
  if (period === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (period === 'week') {
    const date = new Date(now)
    date.setDate(date.getDate() - 6)
    date.setHours(0, 0, 0, 0)
    return date
  }
  return new Date(now.getFullYear(), now.getMonth(), 1)
}

function startOfDay(value: string) {
  return new Date(`${value}T00:00:00`)
}

function endOfDay(value: string) {
  return new Date(`${value}T23:59:59.999`)
}

function toDateKey(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatDayLabel(dateKey: string) {
  return new Intl.DateTimeFormat('en-RW', { month: 'short', day: 'numeric' }).format(new Date(`${dateKey}T12:00:00`))
}

function isWithinRange(dateValue: string, range: OwnerDashboardRange) {
  const date = new Date(dateValue)
  return date >= range.from && date <= range.to
}

export function parseOwnerDashboardRange(searchParams: URLSearchParams): OwnerDashboardRange {
  const fromParam = searchParams.get('from')
  const toParam = searchParams.get('to')
  const period = (searchParams.get('period') ?? 'today') as Period

  if (fromParam && toParam) {
    return {
      period: 'custom',
      from: startOfDay(fromParam),
      to: endOfDay(toParam),
      fromKey: fromParam,
      toKey: toParam,
      label: fromParam === toParam ? formatDayLabel(fromParam) : `${formatDayLabel(fromParam)} - ${formatDayLabel(toParam)}`,
    }
  }

  const from = startOf(period)
  const to = new Date()
  return {
    period,
    from,
    to,
    fromKey: toDateKey(from),
    toKey: toDateKey(to),
    label: period === 'today' ? 'Today' : period === 'week' ? 'Last 7 Days' : 'This Month',
  }
}

export function buildOwnerSyncSnapshot(params: {
  restaurantId: string
  restaurantName: string
  activeOrders: number
  sales: Array<any>
  shifts: Array<any>
  wasteLogs: Array<any>
  expenseTransactions: Array<any>
  transactions: Array<any>
  ingredients: Array<any>
  purchases: Array<any>
  ingredientUsage: Array<any>
  activity: {
    lastSaleAt: Date | null
    lastTransactionAt: Date | null
    lastPendingOrderAt: Date | null
    lastPurchaseAt: Date | null
    lastWasteAt: Date | null
  }
}): OwnerSyncSnapshot {
  return {
    version: 1,
    restaurantId: params.restaurantId,
    restaurantName: params.restaurantName,
    generatedAt: new Date().toISOString(),
    activeOrders: params.activeOrders,
    activity: {
      lastSaleAt: params.activity.lastSaleAt?.toISOString() ?? null,
      lastTransactionAt: params.activity.lastTransactionAt?.toISOString() ?? null,
      lastPendingOrderAt: params.activity.lastPendingOrderAt?.toISOString() ?? null,
      lastPurchaseAt: params.activity.lastPurchaseAt?.toISOString() ?? null,
      lastWasteAt: params.activity.lastWasteAt?.toISOString() ?? null,
    },
    sales: params.sales.map((sale) => ({
      date: sale.saleDate.toISOString(),
      dishId: sale.dishId,
      dishName: sale.dish?.name ?? sale.dishName ?? 'Dish',
      quantitySold: sale.quantitySold ?? 0,
      totalSaleAmount: sale.totalSaleAmount ?? 0,
      calculatedFoodCost: sale.calculatedFoodCost ?? 0,
    })),
    shifts: params.shifts.map((shift) => ({
      date: shift.date.toISOString(),
      calculatedWage: shift.calculatedWage ?? 0,
    })),
    wasteLogs: params.wasteLogs.map((waste) => ({
      date: waste.date.toISOString(),
      calculatedCost: waste.calculatedCost ?? 0,
    })),
    expenseTransactions: params.expenseTransactions.map((txn) => ({
      date: txn.date.toISOString(),
      amount: txn.amount ?? 0,
      type: txn.type,
    })),
    transactions: params.transactions.map((txn) => ({
      id: txn.id,
      date: txn.date.toISOString(),
      description: txn.description,
      amount: txn.amount ?? 0,
      type: txn.type,
      paymentMethod: txn.paymentMethod,
      accountName: txn.account?.name ?? '',
      categoryName: txn.category?.name ?? '',
      categoryType: txn.category?.type ?? '',
      isManual: Boolean(txn.isManual),
    })),
    ingredients: params.ingredients.map((ingredient) => ({
      id: ingredient.id,
      name: ingredient.name,
      unit: ingredient.unit,
      quantity: ingredient.quantity ?? 0,
      unitCost: ingredient.unitCost ?? 0,
      reorderLevel: ingredient.reorderLevel ?? 0,
    })),
    purchases: params.purchases.map((purchase) => ({
      ingredientId: purchase.ingredientId,
      quantityPurchased: purchase.quantityPurchased ?? 0,
      totalCost: purchase.totalCost ?? 0,
      purchasedAt: purchase.purchasedAt.toISOString(),
    })),
    ingredientUsage: params.ingredientUsage.map((usage) => ({
      ingredientId: usage.ingredientId,
      quantityUsed: usage.quantityUsed ?? 0,
      actualCost: usage.actualCost ?? 0,
      saleDate: usage.dishSale.saleDate.toISOString(),
    })),
  }
}

export function buildOwnerDashboardPayload(snapshot: OwnerSyncSnapshot, range: OwnerDashboardRange, source: 'live' | 'snapshot') {
  const sales = snapshot.sales.filter((sale) => isWithinRange(sale.date, range))
  const shifts = snapshot.shifts.filter((shift) => isWithinRange(shift.date, range))
  const wasteLogs = snapshot.wasteLogs.filter((waste) => isWithinRange(waste.date, range))
  const expenseTransactions = snapshot.expenseTransactions.filter((txn) => isWithinRange(txn.date, range))
  const recentTransactions = snapshot.transactions
    .filter((txn) => isWithinRange(txn.date, range))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 20)

  const revenue = sales.reduce((sum, sale) => sum + sale.totalSaleAmount, 0)
  const cogs = sales.reduce((sum, sale) => sum + sale.calculatedFoodCost, 0)
  const laborCost = shifts.reduce((sum, shift) => sum + shift.calculatedWage, 0)
  const wasteCost = wasteLogs.reduce((sum, waste) => sum + waste.calculatedCost, 0)
  const recordedExpenses = expenseTransactions.reduce((sum, txn) => sum + (txn.type === 'debit' ? txn.amount : -txn.amount), 0)
  const expenses = cogs + laborCost + wasteCost + recordedExpenses
  const profit = revenue - expenses
  const foodCostPct = revenue > 0 ? (cogs / revenue) * 100 : 0
  const laborPct = revenue > 0 ? (laborCost / revenue) * 100 : 0
  const wastePct = revenue > 0 ? (wasteCost / revenue) * 100 : 0
  const primeCost = cogs + laborCost
  const primeCostPct = revenue > 0 ? (primeCost / revenue) * 100 : 0

  const topDishMap: Record<string, { name: string; revenue: number; qty: number }> = {}
  for (const sale of sales) {
    if (!topDishMap[sale.dishId]) {
      topDishMap[sale.dishId] = { name: sale.dishName, revenue: 0, qty: 0 }
    }
    topDishMap[sale.dishId].revenue += sale.totalSaleAmount
    topDishMap[sale.dishId].qty += sale.quantitySold
  }
  const topDishes = Object.values(topDishMap).sort((a, b) => b.revenue - a.revenue).slice(0, 5)

  const lowStock = snapshot.ingredients
    .filter((ingredient) => ingredient.quantity <= ingredient.reorderLevel)
    .map((ingredient) => ({
      name: ingredient.name,
      quantity: ingredient.quantity,
      reorderLevel: ingredient.reorderLevel,
      unit: ingredient.unit,
    }))

  const purchaseMap = new Map<string, { qty: number; cost: number }>()
  for (const purchase of snapshot.purchases.filter((entry) => isWithinRange(entry.purchasedAt, range))) {
    const current = purchaseMap.get(purchase.ingredientId) ?? { qty: 0, cost: 0 }
    current.qty += purchase.quantityPurchased
    current.cost += purchase.totalCost
    purchaseMap.set(purchase.ingredientId, current)
  }

  const usageMap = new Map<string, { qty: number; cost: number }>()
  for (const usage of snapshot.ingredientUsage.filter((entry) => isWithinRange(entry.saleDate, range))) {
    const current = usageMap.get(usage.ingredientId) ?? { qty: 0, cost: 0 }
    current.qty += usage.quantityUsed
    current.cost += usage.actualCost
    usageMap.set(usage.ingredientId, current)
  }

  const inventoryItems = snapshot.ingredients.map((ingredient) => {
    const purchased = purchaseMap.get(ingredient.id) ?? { qty: 0, cost: 0 }
    const used = usageMap.get(ingredient.id) ?? { qty: 0, cost: 0 }
    return {
      name: ingredient.name,
      unit: ingredient.unit,
      remainingQty: ingredient.quantity,
      purchasedQty: purchased.qty,
      purchaseCost: purchased.cost,
      usedQty: used.qty,
      usedCost: used.cost,
      stockValue: ingredient.quantity * ingredient.unitCost,
      isLow: ingredient.quantity <= ingredient.reorderLevel,
    }
  })

  const inventoryTotals = inventoryItems.reduce((acc, item) => {
    acc.purchaseCost += item.purchaseCost
    acc.usedCost += item.usedCost
    acc.stockValue += item.stockValue
    return acc
  }, { purchaseCost: 0, usedCost: 0, stockValue: 0 })

  const historyMap = new Map<string, { revenue: number; expenses: number }>()
  for (const sale of sales) {
    const key = toDateKey(new Date(sale.date))
    const current = historyMap.get(key) ?? { revenue: 0, expenses: 0 }
    current.revenue += sale.totalSaleAmount
    current.expenses += sale.calculatedFoodCost
    historyMap.set(key, current)
  }
  for (const shift of shifts) {
    const key = toDateKey(new Date(shift.date))
    const current = historyMap.get(key) ?? { revenue: 0, expenses: 0 }
    current.expenses += shift.calculatedWage
    historyMap.set(key, current)
  }
  for (const waste of wasteLogs) {
    const key = toDateKey(new Date(waste.date))
    const current = historyMap.get(key) ?? { revenue: 0, expenses: 0 }
    current.expenses += waste.calculatedCost
    historyMap.set(key, current)
  }
  for (const txn of expenseTransactions) {
    const key = toDateKey(new Date(txn.date))
    const current = historyMap.get(key) ?? { revenue: 0, expenses: 0 }
    current.expenses += txn.type === 'debit' ? txn.amount : -txn.amount
    historyMap.set(key, current)
  }

  const dailyHistory = Array.from(historyMap.entries())
    .map(([date, totals]) => ({
      date,
      label: formatDayLabel(date),
      revenue: totals.revenue,
      expenses: totals.expenses,
      profit: totals.revenue - totals.expenses,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))

  const activityDates = [
    snapshot.activity.lastSaleAt,
    snapshot.activity.lastTransactionAt,
    snapshot.activity.lastPendingOrderAt,
    snapshot.activity.lastPurchaseAt,
    snapshot.activity.lastWasteAt,
  ].filter(Boolean).map((value) => new Date(value as string))

  const lastActivityAt = activityDates.length > 0
    ? new Date(Math.max(...activityDates.map((date) => date.getTime())))
    : null

  let statusLevel: 'live' | 'recent' | 'stale' = 'stale'
  let statusLabel = 'Quiet'
  let statusDetail = 'No recent branch activity yet.'

  if (lastActivityAt) {
    const minutesSinceActivity = (Date.now() - lastActivityAt.getTime()) / 60000
    if (snapshot.activeOrders > 0 || minutesSinceActivity <= 5) {
      statusLevel = 'live'
      statusLabel = 'Live now'
      statusDetail = snapshot.activeOrders > 0
        ? `${snapshot.activeOrders} order${snapshot.activeOrders === 1 ? '' : 's'} currently active.`
        : 'New business activity reached the system in the last few minutes.'
    } else if (minutesSinceActivity <= 60) {
      statusLevel = 'recent'
      statusLabel = 'Recently active'
      statusDetail = 'The branch has recent activity, but nothing is active right now.'
    } else {
      statusDetail = 'No recent activity has reached the system for a while.'
    }
  }

  return {
    restaurantName: snapshot.restaurantName,
    period: range.period,
    rangeLabel: range.label,
    from: range.fromKey,
    to: range.toKey,
    sync: {
      source,
      generatedAt: snapshot.generatedAt,
    },
    summary: {
      revenue,
      expenses,
      profit,
      salesCount: sales.length,
      transactionCount: recentTransactions.length,
      activeOrders: snapshot.activeOrders,
    },
    costBreakdown: {
      cogs,
      foodCostPct: Number(foodCostPct.toFixed(1)),
      laborCost,
      laborPct: Number(laborPct.toFixed(1)),
      wasteCost,
      wastePct: Number(wastePct.toFixed(1)),
      recordedExpenses,
      primeCost,
      primeCostPct: Number(primeCostPct.toFixed(1)),
    },
    status: {
      level: statusLevel,
      label: statusLabel,
      detail: statusDetail,
      lastActivityAt: lastActivityAt?.toISOString() ?? null,
      activeOrders: snapshot.activeOrders,
    },
    transactions: recentTransactions,
    dailyHistory,
    topDishes,
    lowStock,
    inventory: {
      purchaseCost: inventoryTotals.purchaseCost,
      usedCost: inventoryTotals.usedCost,
      stockValue: inventoryTotals.stockValue,
      lowStockCount: lowStock.length,
      items: inventoryItems
        .sort((a, b) => Number(b.isLow) - Number(a.isLow) || b.usedCost - a.usedCost)
        .slice(0, 8),
    },
  }
}