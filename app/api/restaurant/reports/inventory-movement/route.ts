import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

// GET — inventory movement report
// Returns: per ingredient — qty purchased, purchase cost, qty used, remaining qty
export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')

  const dateFilter = from && to
    ? { purchasedAt: { gte: new Date(from), lte: new Date(to + 'T23:59:59') } }
    : {}

  const [ingredients, purchases, saleIngredients, dishSales] = await Promise.all([
    // All ingredients
    prisma.inventoryItem.findMany({
      where: { userId: session.user.id, inventoryType: 'ingredient' },
      select: { id: true, name: true, unit: true, quantity: true, unitCost: true, reorderLevel: true },
    }),

    // All purchase batches (optionally date-filtered)
    prisma.inventoryPurchase.findMany({
      where: { userId: session.user.id, ...dateFilter },
      select: { ingredientId: true, quantityPurchased: true, totalCost: true, purchasedAt: true },
    }),

    // FIFO-tracked usage (from DishSaleIngredient when FIFO is on)
    prisma.dishSaleIngredient.findMany({
      where: {
        dishSale: {
          userId: session.user.id,
          ...(from && to ? { saleDate: { gte: new Date(from), lte: new Date(to + 'T23:59:59') } } : {}),
        },
      },
      select: { ingredientId: true, quantityUsed: true, actualCost: true },
    }),

    // Fallback: dish sales with recipe data for non-FIFO usage calculation
    prisma.dishSale.findMany({
      where: {
        userId: session.user.id,
        ...(from && to ? { saleDate: { gte: new Date(from), lte: new Date(to + 'T23:59:59') } } : {}),
      },
      include: {
        dish: {
          include: { ingredients: true },
        },
      },
    }),
  ])

  // Build lookup maps
  const purchaseMap = new Map<string, { qty: number; cost: number }>()
  for (const p of purchases) {
    const e = purchaseMap.get(p.ingredientId) ?? { qty: 0, cost: 0 }
    e.qty += p.quantityPurchased
    e.cost += p.totalCost
    purchaseMap.set(p.ingredientId, e)
  }

  // Usage via DishSaleIngredient (FIFO mode)
  const fifoUsageMap = new Map<string, { qty: number; cost: number }>()
  for (const si of saleIngredients) {
    const e = fifoUsageMap.get(si.ingredientId) ?? { qty: 0, cost: 0 }
    e.qty += si.quantityUsed
    e.cost += si.actualCost
    fifoUsageMap.set(si.ingredientId, e)
  }

  // Usage via recipe × qty sold (non-FIFO fallback)
  const recipeUsageMap = new Map<string, number>()
  for (const sale of dishSales) {
    for (const ing of sale.dish.ingredients) {
      const used = ing.quantityRequired * sale.quantitySold
      recipeUsageMap.set(ing.ingredientId, (recipeUsageMap.get(ing.ingredientId) ?? 0) + used)
    }
  }

  const rows = ingredients.map(ing => {
    const purchased = purchaseMap.get(ing.id) ?? { qty: 0, cost: 0 }
    // Prefer FIFO usage detail if present, else fall back to recipe calculation
    const hasFifo = fifoUsageMap.has(ing.id)
    const usedQty = hasFifo
      ? (fifoUsageMap.get(ing.id)?.qty ?? 0)
      : (recipeUsageMap.get(ing.id) ?? 0)
    const usedCost = hasFifo
      ? (fifoUsageMap.get(ing.id)?.cost ?? 0)
      : usedQty * (ing.unitCost ?? 0)

    return {
      id: ing.id,
      name: ing.name,
      unit: ing.unit,
      purchasedQty: purchased.qty,
      purchaseCost: purchased.cost,
      usedQty,
      usedCost,
      remainingQty: ing.quantity,
      unitCost: ing.unitCost ?? 0,
      stockValue: ing.quantity * (ing.unitCost ?? 0),
      isLow: ing.quantity <= ing.reorderLevel,
      isFifoTracked: hasFifo,
    }
  }).sort((a, b) => a.name.localeCompare(b.name))

  const totals = rows.reduce((acc, r) => ({
    purchasedQty: acc.purchasedQty, // meaningless to sum across units
    purchaseCost: acc.purchaseCost + r.purchaseCost,
    usedCost: acc.usedCost + r.usedCost,
    stockValue: acc.stockValue + r.stockValue,
  }), { purchasedQty: 0, purchaseCost: 0, usedCost: 0, stockValue: 0 })

  return NextResponse.json({ items: rows, totals })
}
