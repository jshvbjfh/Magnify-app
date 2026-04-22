import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { buildOwnerSyncSnapshot } from '@/lib/ownerSync'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const role = (session.user as any).role
  if (role !== 'admin') {
    return NextResponse.json({ error: 'Only the restaurant manager desktop can export sync data.' }, { status: 403 })
  }

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId) {
    return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 })
  }

  const billingUserId = context.billingUserId
  const restaurantId = context.restaurantId
  const branchId = context.branchId ?? null

  const restaurant = await prisma.restaurant.findFirst({
    where: { id: restaurantId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  })

  if (!restaurant) {
    return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 })
  }

  const lookbackStart = new Date()
  lookbackStart.setDate(lookbackStart.getDate() - 90)

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
        userId: billingUserId,
        restaurantId,
        ...(branchId ? { branchId } : {}),
        saleDate: { gte: lookbackStart },
      },
      include: { dish: { select: { name: true } } },
      orderBy: { saleDate: 'desc' },
    }),
    prisma.shift.findMany({
      where: {
        userId: billingUserId,
        restaurantId,
        ...(branchId ? { branchId } : {}),
        date: { gte: lookbackStart },
      },
      orderBy: { date: 'desc' },
    }),
    prisma.wasteLog.findMany({
      where: {
        userId: billingUserId,
        restaurantId,
        ...(branchId ? { branchId } : {}),
        date: { gte: lookbackStart },
      },
      orderBy: { date: 'desc' },
    }),
    prisma.transaction.findMany({
      where: {
        userId: billingUserId,
        restaurantId,
        ...(branchId ? { branchId } : {}),
        date: { gte: lookbackStart },
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
    }),
    prisma.transaction.findMany({
      where: {
        userId: billingUserId,
        restaurantId,
        ...(branchId ? { branchId } : {}),
        date: { gte: lookbackStart },
      },
      include: {
        account: { select: { name: true } },
        category: { select: { name: true, type: true } },
      },
      orderBy: { date: 'desc' },
      take: 300,
    }),
    prisma.inventoryItem.findMany({
      where: {
        userId: billingUserId,
        inventoryType: 'ingredient',
        restaurantId,
        ...(branchId ? { branchId } : {}),
      },
      orderBy: { name: 'asc' },
    }),
    prisma.inventoryPurchase.findMany({
      where: {
        userId: billingUserId,
        restaurantId,
        ...(branchId ? { branchId } : {}),
        purchasedAt: { gte: lookbackStart },
      },
      orderBy: { purchasedAt: 'desc' },
    }),
    prisma.dishSaleIngredient.findMany({
      where: {
        dishSale: {
          userId: billingUserId,
          restaurantId,
          ...(branchId ? { branchId } : {}),
          saleDate: { gte: lookbackStart },
        },
      },
      include: { dishSale: { select: { saleDate: true } } },
    }),
    prisma.pendingOrder.count({
      where: { restaurantId: restaurant.id, ...(branchId ? { branchId } : {}), status: { in: ['new', 'in_kitchen'] } },
    }),
    prisma.dishSale.findFirst({ where: { userId: billingUserId, restaurantId, ...(branchId ? { branchId } : {}) }, orderBy: { saleDate: 'desc' }, select: { saleDate: true } }),
    prisma.transaction.findFirst({ where: { userId: billingUserId, restaurantId, ...(branchId ? { branchId } : {}) }, orderBy: { date: 'desc' }, select: { date: true } }),
    prisma.pendingOrder.findFirst({ where: { restaurantId: restaurant.id, ...(branchId ? { branchId } : {}) }, orderBy: { addedAt: 'desc' }, select: { addedAt: true } }),
    prisma.inventoryPurchase.findFirst({ where: { userId: billingUserId, restaurantId, ...(branchId ? { branchId } : {}) }, orderBy: { purchasedAt: 'desc' }, select: { purchasedAt: true } }),
    prisma.wasteLog.findFirst({ where: { userId: billingUserId, restaurantId, ...(branchId ? { branchId } : {}) }, orderBy: { date: 'desc' }, select: { date: true } }),
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

  return NextResponse.json({ snapshot })
}