import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getIngredientLayerSnapshotAsOf } from '@/lib/inventoryLayerSnapshot'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser, isMainRestaurantBranch } from '@/lib/restaurantAccess'
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

// GET — theoretical inventory report
// Returns: opening, purchases, theoretical usage, waste, theoretical closing, actual on hand, variance
export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  const billingUserId = context?.billingUserId ?? session.user.id
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
      meta: {
        fifoEnabled: false,
        fifoCutoverAt: null,
      },
    })
  }

  const includeBranchlessRows = await isMainRestaurantBranch(restaurantId, branchId)
  const branchScopeWhere = includeBranchlessRows
    ? { OR: [{ branchId }, { branchId: null }] }
    : { branchId }

  const { searchParams } = new URL(req.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')

  const startDate = from ? new Date(`${from}T00:00:00`) : null
  const endDate = to ? new Date(`${to}T23:59:59.999`) : null
  const effectiveEndDate = endDate ?? new Date()

  const [ingredients, purchases, wasteLogs, layerSnapshot, dishSaleUsage, restaurant] = await Promise.all([
    prisma.inventoryItem.findMany({
      where: {
        userId: billingUserId,
        inventoryType: 'ingredient',
        ...(restaurantId ? { restaurantId } : {}),
        ...branchScopeWhere,
      },
      select: { id: true, name: true, unit: true, quantity: true, unitCost: true, reorderLevel: true, createdAt: true, lastRestockedAt: true },
      orderBy: { name: 'asc' },
    }),
    prisma.inventoryPurchase.findMany({
      where: {
        userId: billingUserId,
        ...(restaurantId ? { restaurantId } : {}),
        ...branchScopeWhere,
        ...(endDate ? { purchasedAt: { lte: endDate } } : {}),
      },
      select: { ingredientId: true, quantityPurchased: true, totalCost: true, purchasedAt: true },
    }),
    prisma.wasteLog.findMany({
      where: {
        userId: billingUserId,
        ...(restaurantId ? { restaurantId } : {}),
        ...branchScopeWhere,
        ...(endDate ? { date: { lte: endDate } } : {}),
      },
      select: { ingredientId: true, quantityWasted: true, calculatedCost: true, date: true },
    }),

    getIngredientLayerSnapshotAsOf(prisma, {
      billingUserId,
      restaurantId,
      branchId,
      includeBranchlessRows,
      endDate: effectiveEndDate,
    }),

    getDishSaleUsageBreakdown(prisma, {
      billingUserId,
      restaurantId,
      branchId,
      includeBranchlessRows,
      startDate,
      endDate,
    }),

    restaurantId
      ? prisma.restaurant.findUnique({
          where: { id: restaurantId },
          select: { fifoEnabled: true, fifoCutoverAt: true },
        })
      : Promise.resolve(null),
  ])

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
      const baselineDate = ingredient.lastRestockedAt ?? ingredient.createdAt
      if (isBeforeRange(baselineDate, startDate)) {
        beforePurchase = { qty: inferredBaselineQty, cost: baselineCost }
      } else if (isInRange(baselineDate, startDate, endDate)) {
        periodPurchase = { qty: inferredBaselineQty, cost: baselineCost }
      }
    }

    const openingQty = roundQty(beforePurchase.qty - beforeUsage.qty - beforeWasteQty.qty)
    const theoreticalQty = roundQty(openingQty + periodPurchase.qty - periodUsage.qty - periodWasteQty.qty)
    const hasBatchHistory = layerSnapshot.hasPurchaseHistory.has(ingredient.id)
    const layerTotals = layerSnapshot.ingredientTotals.get(ingredient.id)
    const actualQty = hasBatchHistory
      ? roundQty(Number(layerTotals?.quantity ?? 0))
      : roundQty(ingredient.quantity)
    const varianceQty = roundQty(actualQty - theoreticalQty)
    const varianceCost = roundQty(varianceQty * (ingredient.unitCost ?? 0))
    const wasteCost = roundQty(periodWasteQty.cost)
    const theoreticalStockValue = roundQty(theoreticalQty * (ingredient.unitCost ?? 0))
    const actualStockValue = hasBatchHistory
      ? roundQty(Number(layerTotals?.value ?? 0))
      : roundQty(actualQty * (ingredient.unitCost ?? 0))

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
      actualQty,
      varianceQty,
      varianceCost,
      theoreticalStockValue,
      actualStockValue,
      isLow: actualQty <= ingredient.reorderLevel,
      varianceStatus: Math.abs(varianceQty) < 0.001 ? 'Matched' : varianceQty > 0 ? 'Over' : 'Short',
      usageSource: hasFifoUsage ? 'fifo' : 'recipe',
      usageMode,
      actualStockValueMode: hasBatchHistory ? 'fifo_layers' : 'unit_cost_fallback',
    }
  })

  const totals = items.reduce((acc, item) => ({
    totalPurchaseCost: acc.totalPurchaseCost + item.purchaseCost,
    totalUsedCost: acc.totalUsedCost + item.usedCost,
    totalWasteCost: acc.totalWasteCost + item.wasteCost,
    totalTheoreticalStockValue: acc.totalTheoreticalStockValue + item.theoreticalStockValue,
    totalActualStockValue: acc.totalActualStockValue + item.actualStockValue,
    totalVarianceCost: acc.totalVarianceCost + item.varianceCost,
    matchedCount: acc.matchedCount + (item.varianceStatus === 'Matched' ? 1 : 0),
    varianceCount: acc.varianceCount + (item.varianceStatus === 'Matched' ? 0 : 1),
  }), {
    totalPurchaseCost: 0,
    totalUsedCost: 0,
    totalWasteCost: 0,
    totalTheoreticalStockValue: 0,
    totalActualStockValue: 0,
    totalVarianceCost: 0,
    matchedCount: 0,
    varianceCount: 0,
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
    meta: {
      fifoEnabled: restaurant?.fifoEnabled ?? false,
      fifoCutoverAt: restaurant?.fifoCutoverAt?.toISOString() ?? null,
    },
  })
}