import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getIngredientLayerSnapshotAsOf } from '@/lib/inventoryLayerSnapshot'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { getDishSaleUsageBreakdown } from '@/lib/restaurantReportUsage'

function roundQty(value: number) {
  return Math.round((value + Number.EPSILON) * 1000) / 1000
}

function isInRange(date: Date, start: Date | null, end: Date | null) {
  if (start && date < start) return false
  if (end && date > end) return false
  return true
}

function isBeforeRange(date: Date, start: Date | null) {
  return start ? date < start : false
}

type QtyCost = { qty: number; cost: number }

function addQtyCost(map: Map<string, QtyCost>, ingredientId: string, qty: number, cost: number) {
  const current = map.get(ingredientId) ?? { qty: 0, cost: 0 }
  current.qty += qty
  current.cost += cost
  map.set(ingredientId, current)
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null
  if (!restaurantId || !branchId) {
    return NextResponse.json({
      items: [],
      totals: {
        totalPurchaseCost: 0,
        totalUsedCost: 0,
        totalWasteCost: 0,
        totalTheoreticalStockValue: 0,
        totalActualStockValue: 0,
        totalVarianceCost: 0,
        matchedCount: 0,
        varianceCount: 0,
      },
      meta: { fifoEnabled: true, fifoCutoverAt: null },
    })
  }

  const { searchParams } = new URL(req.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')

  const startDate = from ? new Date(`${from}T00:00:00`) : null
  const endDate = to ? new Date(`${to}T23:59:59.999`) : null
  const effectiveEndDate = endDate ?? new Date()

  const [ingredients, purchases, wasteLogs, layerSnapshot, dishSaleUsage, rawStockTakes] = await Promise.all([
    prisma.inventoryItem.findMany({
      where: { restaurantId, branchId },
      select: { id: true, name: true, unit: true, quantity: true, unitCost: true, reorderLevel: true, createdAt: true },
      orderBy: { name: 'asc' },
    }),
    prisma.inventoryPurchase.findMany({
      where: {
        restaurantId,
        branchId,
        ...(endDate ? { purchasedAt: { lte: endDate } } : {}),
      },
      select: { ingredientId: true, quantityPurchased: true, totalCost: true, purchasedAt: true },
    }),
    prisma.wasteLog.findMany({
      where: {
        restaurantId,
        branchId,
        ...(endDate ? { date: { lte: endDate } } : {}),
      },
      select: { ingredientId: true, quantityWasted: true, calculatedCost: true, date: true },
    }),
    getIngredientLayerSnapshotAsOf(prisma, { restaurantId, branchId, endDate: effectiveEndDate }),
    getDishSaleUsageBreakdown(prisma, { restaurantId, branchId, startDate, endDate }),
    prisma.stockTake.findMany({
      where: {
        restaurantId,
        branchId,
        takenAt: { lte: effectiveEndDate },
      },
      orderBy: { takenAt: 'desc' },
      select: { ingredientId: true, quantity: true, takenAt: true },
    }),
  ])

  // Deduplicate to the latest stock take per ingredient within the report window
  const stockTakeMap = new Map<string, { quantity: number; takenAt: Date }>()
  for (const t of rawStockTakes) {
    if (!stockTakeMap.has(t.ingredientId)) stockTakeMap.set(t.ingredientId, t)
  }

  const beforePurchases = new Map<string, QtyCost>()
  const periodPurchases = new Map<string, QtyCost>()
  for (const purchase of purchases) {
    if (isBeforeRange(purchase.purchasedAt, startDate)) {
      addQtyCost(beforePurchases, purchase.ingredientId, purchase.quantityPurchased, purchase.totalCost)
      continue
    }
    if (isInRange(purchase.purchasedAt, startDate, endDate)) {
      addQtyCost(periodPurchases, purchase.ingredientId, purchase.quantityPurchased, purchase.totalCost)
    }
  }

  const beforeWaste = new Map<string, QtyCost>()
  const periodWaste = new Map<string, QtyCost>()
  for (const waste of wasteLogs) {
    if (isBeforeRange(waste.date, startDate)) {
      addQtyCost(beforeWaste, waste.ingredientId, waste.quantityWasted, waste.calculatedCost)
      continue
    }
    if (isInRange(waste.date, startDate, endDate)) {
      addQtyCost(periodWaste, waste.ingredientId, waste.quantityWasted, waste.calculatedCost)
    }
  }

  const items = ingredients.map((ingredient) => {
    let beforePurchase = beforePurchases.get(ingredient.id) ?? { qty: 0, cost: 0 }
    let periodPurchase = periodPurchases.get(ingredient.id) ?? { qty: 0, cost: 0 }
    const beforeWasteQty = beforeWaste.get(ingredient.id) ?? { qty: 0, cost: 0 }
    const periodWasteQty = periodWaste.get(ingredient.id) ?? { qty: 0, cost: 0 }
    const beforeUsage = dishSaleUsage.beforeUsageMap.get(ingredient.id) ?? { qty: 0, cost: 0 }
    const periodUsage = dishSaleUsage.periodUsageMap.get(ingredient.id) ?? { qty: 0, cost: 0 }
    const hasFifoUsage = dishSaleUsage.hasLedgerUsage.has(ingredient.id)
    const usageMode = dishSaleUsage.usageModeByIngredient.get(ingredient.id) ?? 'none'

    const hasPurchaseHistory = beforePurchases.has(ingredient.id) || periodPurchases.has(ingredient.id)
    if (!hasPurchaseHistory && (ingredient.unitCost ?? 0) > 0) {
      const inferredBaselineQty = roundQty(ingredient.quantity + beforeUsage.qty + periodUsage.qty + beforeWasteQty.qty + periodWasteQty.qty)
      const baselineCost = roundQty(inferredBaselineQty * (ingredient.unitCost ?? 0))
      const baselineDate = ingredient.createdAt
      if (isBeforeRange(baselineDate, startDate)) {
        beforePurchase = { qty: inferredBaselineQty, cost: baselineCost }
      } else if (isInRange(baselineDate, startDate, endDate)) {
        periodPurchase = { qty: inferredBaselineQty, cost: baselineCost }
      }
    }

    const openingQty = roundQty(beforePurchase.qty - beforeUsage.qty - beforeWasteQty.qty)
    const theoreticalQty = roundQty(openingQty + periodPurchase.qty - periodUsage.qty - periodWasteQty.qty)
    const theoreticalStockValue = roundQty(theoreticalQty * (ingredient.unitCost ?? 0))
    const wasteCost = roundQty(periodWasteQty.cost)

    const stockTake = stockTakeMap.get(ingredient.id) ?? null
    const hasCount = stockTake !== null
    const actualQty = hasCount ? roundQty(stockTake.quantity) : null
    const varianceQty = hasCount ? roundQty(actualQty! - theoreticalQty) : null
    const varianceCost = hasCount ? roundQty(varianceQty! * (ingredient.unitCost ?? 0)) : null
    const actualStockValue = hasCount ? roundQty(actualQty! * (ingredient.unitCost ?? 0)) : null
    const varianceStatus = !hasCount
      ? 'No Count'
      : Math.abs(varianceQty!) < 0.001 ? 'Matched'
      : varianceQty! > 0 ? 'Over' : 'Short'

    return {
      id: ingredient.id,
      ingredientName: ingredient.name,
      unit: ingredient.unit,
      unitCost: ingredient.unitCost ?? 0,
      openingQty,
      purchasedQty: roundQty(periodPurchase.qty),
      purchaseCost: roundQty(periodPurchase.cost),
      usedQty: roundQty(periodUsage.qty),
      usedCost: roundQty(periodUsage.cost),
      wasteQty: roundQty(periodWasteQty.qty),
      wasteCost,
      theoreticalQty,
      theoreticalStockValue,
      actualQty,
      varianceQty,
      varianceCost,
      actualStockValue,
      hasCount,
      countedAt: stockTake?.takenAt ?? null,
      isLow: (actualQty ?? 0) <= ingredient.reorderLevel,
      varianceStatus,
      usageSource: hasFifoUsage ? 'fifo' : 'recipe',
      usageMode,
    }
  })

  const totals = items.reduce((acc, item) => ({
    totalPurchaseCost: acc.totalPurchaseCost + item.purchaseCost,
    totalUsedCost: acc.totalUsedCost + item.usedCost,
    totalWasteCost: acc.totalWasteCost + item.wasteCost,
    totalTheoreticalStockValue: acc.totalTheoreticalStockValue + item.theoreticalStockValue,
    totalActualStockValue: acc.totalActualStockValue + (item.actualStockValue ?? 0),
    totalVarianceCost: acc.totalVarianceCost + (item.varianceCost ?? 0),
    matchedCount: acc.matchedCount + (item.varianceStatus === 'Matched' ? 1 : 0),
    varianceCount: acc.varianceCount + (item.varianceStatus !== 'Matched' && item.varianceStatus !== 'No Count' ? 1 : 0),
    noCountCount: acc.noCountCount + (item.varianceStatus === 'No Count' ? 1 : 0),
    countedCount: acc.countedCount + (item.hasCount ? 1 : 0),
  }), {
    totalPurchaseCost: 0,
    totalUsedCost: 0,
    totalWasteCost: 0,
    totalTheoreticalStockValue: 0,
    totalActualStockValue: 0,
    totalVarianceCost: 0,
    matchedCount: 0,
    varianceCount: 0,
    noCountCount: 0,
    countedCount: 0,
  })

  return NextResponse.json({
    items,
    totals: {
      ...totals,
      totalPurchaseCost: roundQty(totals.totalPurchaseCost),
      totalUsedCost: roundQty(totals.totalUsedCost),
      totalWasteCost: roundQty(totals.totalWasteCost),
      totalTheoreticalStockValue: roundQty(totals.totalTheoreticalStockValue),
      totalActualStockValue: roundQty(totals.totalActualStockValue),
      totalVarianceCost: roundQty(totals.totalVarianceCost),
    },
    meta: { fifoEnabled: true, fifoCutoverAt: null, stockTakeMode: true },
  })
}
