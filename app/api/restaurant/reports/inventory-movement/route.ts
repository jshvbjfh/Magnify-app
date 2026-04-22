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

// GET — inventory movement report
// Returns: per ingredient — qty purchased, purchase cost, qty used, remaining qty
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
        purchasedQty: 0,
        purchaseCost: 0,
        usedCost: 0,
        stockValue: 0,
        totalPurchaseCost: 0,
        totalUsedCost: 0,
        totalStockValue: 0,
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

  const dateFilter = from && to
    ? { purchasedAt: { gte: new Date(from), lte: new Date(to + 'T23:59:59') } }
    : {}

  const endDate = to ? new Date(to + 'T23:59:59') : new Date()
  const startDate = from ? new Date(from + 'T00:00:00') : null

  const [ingredients, purchases, layerSnapshot, dishSaleUsage, wasteLogsToEnd, restaurant] = await Promise.all([
    // All ingredients
    prisma.inventoryItem.findMany({
      where: {
        userId: billingUserId,
        inventoryType: 'ingredient',
        ...(restaurantId ? { restaurantId } : {}),
        ...branchScopeWhere,
      },
      select: { id: true, name: true, unit: true, quantity: true, unitCost: true, reorderLevel: true, createdAt: true, lastRestockedAt: true },
    }),

    // All purchase batches (optionally date-filtered)
    prisma.inventoryPurchase.findMany({
      where: {
        userId: billingUserId,
        ...(restaurantId ? { restaurantId } : {}),
        ...branchScopeWhere,
        ...dateFilter,
      },
      select: { ingredientId: true, quantityPurchased: true, totalCost: true, purchasedAt: true },
    }),

    getIngredientLayerSnapshotAsOf(prisma, {
      billingUserId,
      restaurantId,
      branchId,
      includeBranchlessRows,
      endDate,
    }),

    getDishSaleUsageBreakdown(prisma, {
      billingUserId,
      restaurantId,
      branchId,
      includeBranchlessRows,
      startDate,
      endDate,
    }),

    prisma.wasteLog.findMany({
      where: {
        userId: billingUserId,
        ...(restaurantId ? { restaurantId } : {}),
        ...branchScopeWhere,
        date: { lte: endDate },
      },
      select: { ingredientId: true, quantityWasted: true, date: true },
    }),

    restaurantId
      ? prisma.restaurant.findUnique({
          where: { id: restaurantId },
          select: { fifoEnabled: true, fifoCutoverAt: true },
        })
      : Promise.resolve(null),
  ])

  // Build lookup maps
  const purchaseMap = new Map<string, { qty: number; cost: number }>()
  for (const p of purchases) {
    const e = purchaseMap.get(p.ingredientId) ?? { qty: 0, cost: 0 }
    e.qty += p.quantityPurchased
    e.cost += p.totalCost
    purchaseMap.set(p.ingredientId, e)
  }

  const totalWasteToEndMap = new Map<string, number>()
  const periodWasteMap = new Map<string, number>()
  for (const waste of wasteLogsToEnd) {
    totalWasteToEndMap.set(waste.ingredientId, (totalWasteToEndMap.get(waste.ingredientId) ?? 0) + waste.quantityWasted)
    const isInPeriod = !startDate || waste.date >= startDate
    if (isInPeriod) {
      periodWasteMap.set(waste.ingredientId, (periodWasteMap.get(waste.ingredientId) ?? 0) + waste.quantityWasted)
    }
  }

  const rows = ingredients.map(ing => {
    let purchased = purchaseMap.get(ing.id) ?? { qty: 0, cost: 0 }
    const usage = dishSaleUsage.periodUsageMap.get(ing.id) ?? { qty: 0, cost: 0 }
    const hasFifo = dishSaleUsage.hasLedgerUsage.has(ing.id)
    const usageMode = dishSaleUsage.usageModeByIngredient.get(ing.id) ?? 'none'
    const usedQty = usage.qty
    const usedCost = usage.cost
    const periodWasteQty = roundQty(periodWasteMap.get(ing.id) ?? 0)
    const hasBatchHistory = layerSnapshot.hasPurchaseHistory.has(ing.id)
    const layerTotals = layerSnapshot.ingredientTotals.get(ing.id)
    const remainingQty = hasBatchHistory
      ? roundQty(Number(layerTotals?.quantity ?? 0))
      : roundQty(Number(ing.quantity ?? 0))
    const stockValue = hasBatchHistory
      ? roundQty(Number(layerTotals?.value ?? 0))
      : roundQty(remainingQty * Number(ing.unitCost ?? 0))

    if (!hasBatchHistory && (ing.unitCost ?? 0) > 0) {
      const inferredOpeningQty = ing.quantity + (dishSaleUsage.totalUsageToEndMap.get(ing.id)?.qty ?? 0) + (totalWasteToEndMap.get(ing.id) ?? 0)
      const baselineDate = ing.lastRestockedAt ?? ing.createdAt
      const fallsInRange = !startDate || baselineDate >= startDate
      if (fallsInRange) {
        purchased = {
          qty: inferredOpeningQty,
          cost: inferredOpeningQty * (ing.unitCost ?? 0),
        }
      }
    }

    const openingQty = roundQty(remainingQty + usedQty + periodWasteQty - purchased.qty)

    return {
      id: ing.id,
      ingredientName: ing.name,
      name: ing.name,
      unit: ing.unit,
      openingQty,
      purchasedQty: purchased.qty,
      purchaseCost: purchased.cost,
      usedQty,
      usedCost,
      remainingQty,
      unitCost: ing.unitCost ?? 0,
      stockValue,
      isLow: remainingQty <= ing.reorderLevel,
      isFifoTracked: hasFifo,
      usageMode,
      stockValueMode: hasBatchHistory ? 'fifo_layers' : 'unit_cost_fallback',
    }
  }).sort((a, b) => a.name.localeCompare(b.name))

  const totals = rows.reduce((acc, r) => ({
    purchasedQty: acc.purchasedQty, // meaningless to sum across units
    purchaseCost: acc.purchaseCost + r.purchaseCost,
    usedCost: acc.usedCost + r.usedCost,
    stockValue: acc.stockValue + r.stockValue,
  }), { purchasedQty: 0, purchaseCost: 0, usedCost: 0, stockValue: 0 })

  return NextResponse.json({
    items: rows,
    totals: {
      purchasedQty: totals.purchasedQty,
      purchaseCost: totals.purchaseCost,
      usedCost: totals.usedCost,
      stockValue: totals.stockValue,
      totalPurchaseCost: totals.purchaseCost,
      totalUsedCost: totals.usedCost,
      totalStockValue: totals.stockValue,
    },
    meta: {
      fifoEnabled: restaurant?.fifoEnabled ?? false,
      fifoCutoverAt: restaurant?.fifoCutoverAt?.toISOString() ?? null,
    },
  })
}
