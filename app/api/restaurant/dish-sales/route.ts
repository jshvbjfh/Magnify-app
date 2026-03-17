import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')

  // For waiters, show the restaurant's sales (recorded under admin)
  const currentUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { role: true, restaurantId: true }
  })
  let queryUserId = session.user.id
  if ((currentUser?.role === 'waiter' || currentUser?.role === 'kitchen') && currentUser.restaurantId) {
    const restaurant = await prisma.restaurant.findUnique({ where: { id: currentUser.restaurantId } })
    if (restaurant) queryUserId = restaurant.ownerId
  }

  const sales = await prisma.dishSale.findMany({
    where: {
      userId: queryUserId,
      ...(from && to && { saleDate: { gte: new Date(from), lte: new Date(to) } }),
    },
    include: { dish: true },
    orderBy: { saleDate: 'desc' }
  })
  return NextResponse.json(sales)
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { dishId, quantitySold, paymentMethod, saleDate } = await req.json()
  if (!dishId || !quantitySold) {
    return NextResponse.json({ error: 'dishId and quantitySold required' }, { status: 400 })
  }

  const qty = Number(quantitySold)

  // Resolve billing owner (waiters bill under restaurant admin)
  const currentUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { role: true, restaurantId: true }
  })
  let billingUserId = session.user.id
  if ((currentUser?.role === 'waiter' || currentUser?.role === 'kitchen') && currentUser.restaurantId) {
    const restaurant = await prisma.restaurant.findUnique({ where: { id: currentUser.restaurantId } })
    if (restaurant) billingUserId = restaurant.ownerId
  }

  // Check if the billing owner has FIFO enabled
  const owner = await prisma.user.findUnique({
    where: { id: billingUserId },
    select: { fifoEnabled: true }
  })
  const fifoEnabled = (owner as any)?.fifoEnabled ?? false

  // Fetch dish + recipe
  const dish = await prisma.dish.findFirst({
    where: { id: dishId, userId: billingUserId },
    include: { ingredients: { include: { ingredient: true } } }
  })
  if (!dish) return NextResponse.json({ error: 'Dish not found' }, { status: 404 })

  const totalSaleAmount = dish.sellingPrice * qty
  let calculatedFoodCost = 0

  // ── Ingredient deduction ──────────────────────────────────────────────────
  // Records per ingredient used (for DishSaleIngredient)
  const ingredientLines: { ingredientId: string; quantityUsed: number; actualCost: number }[] = []

  for (const row of dish.ingredients) {
    const totalNeeded = row.quantityRequired * qty

    if (fifoEnabled) {
      // FIFO: consume from oldest batches first
      let remaining = totalNeeded
      let lineCost = 0

      const batches = await prisma.inventoryPurchase.findMany({
        where: { ingredientId: row.ingredientId, userId: billingUserId, remainingQuantity: { gt: 0 } },
        orderBy: { purchasedAt: 'asc' }
      })

      for (const batch of batches) {
        if (remaining <= 0) break
        const take = Math.min(batch.remainingQuantity, remaining)
        lineCost += take * batch.unitCost
        remaining -= take

        await prisma.inventoryPurchase.update({
          where: { id: batch.id },
          data: { remainingQuantity: { decrement: take } }
        })
      }

      // If batches didn't cover everything (e.g. no purchases recorded), fall back to unitCost
      if (remaining > 0) {
        lineCost += remaining * (row.ingredient.unitCost ?? 0)
      }

      calculatedFoodCost += lineCost
      ingredientLines.push({ ingredientId: row.ingredientId, quantityUsed: totalNeeded, actualCost: lineCost })
    } else {
      // Simple mode: use current unitCost
      const cost = totalNeeded * (row.ingredient.unitCost ?? 0)
      calculatedFoodCost += cost
      ingredientLines.push({ ingredientId: row.ingredientId, quantityUsed: totalNeeded, actualCost: cost })
    }

    // Always deduct from inventory quantity
    await prisma.inventoryItem.update({
      where: { id: row.ingredientId },
      data: { quantity: { decrement: totalNeeded } }
    })
  }

  // ── Accounting entries ────────────────────────────────────────────────────
  let salesCategory = await prisma.category.findFirst({ where: { name: 'Sales Revenue' } })
  if (!salesCategory) salesCategory = await prisma.category.create({ data: { name: 'Sales Revenue', type: 'income', description: 'Revenue from dish sales' } })
  let salesAccount = await prisma.account.findFirst({ where: { name: 'Restaurant Sales' } })
  if (!salesAccount) salesAccount = await prisma.account.create({ data: { code: 'REST-SAL-001', name: 'Restaurant Sales', categoryId: salesCategory.id, type: 'revenue', description: 'Restaurant dish sales account' } })
  let cashCategory = await prisma.category.findFirst({ where: { name: 'Asset' } })
  if (!cashCategory) cashCategory = await prisma.category.create({ data: { name: 'Asset', type: 'asset', description: 'Asset accounts' } })
  let cashAccount = await prisma.account.findFirst({ where: { name: 'Cash' } })
  if (!cashAccount) cashAccount = await prisma.account.create({ data: { code: '1000', name: 'Cash', categoryId: cashCategory.id, type: 'asset', description: 'Cash on hand' } })

  const pairId = `pair-sale-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const txDate = saleDate ? new Date(saleDate) : new Date()
  const txDesc = `${dish.name} × ${qty}`
  const profit = totalSaleAmount - calculatedFoodCost

  await prisma.transaction.createMany({
    data: [
      { userId: billingUserId, accountId: cashAccount.id, categoryId: cashCategory.id, date: txDate, description: txDesc, amount: totalSaleAmount, type: 'debit', isManual: true, paymentMethod: paymentMethod || 'Cash', pairId, profitAmount: profit, costAmount: calculatedFoodCost },
      { userId: billingUserId, accountId: salesAccount.id, categoryId: salesCategory.id, date: txDate, description: txDesc, amount: totalSaleAmount, type: 'credit', isManual: true, paymentMethod: paymentMethod || 'Cash', pairId, profitAmount: profit, costAmount: calculatedFoodCost },
    ]
  })

  // ── Record sale + ingredient breakdown ───────────────────────────────────
  const sale = await prisma.dishSale.create({
    data: {
      userId: billingUserId,
      dishId,
      quantitySold: qty,
      saleDate: txDate,
      paymentMethod: paymentMethod || 'Cash',
      totalSaleAmount,
      calculatedFoodCost,
      saleIngredients: {
        create: ingredientLines
      }
    }
  })

  return NextResponse.json({ sale, totalSaleAmount, calculatedFoodCost, fifoEnabled }, { status: 201 })
}

