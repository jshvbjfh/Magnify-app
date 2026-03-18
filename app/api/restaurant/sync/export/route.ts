import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { buildOwnerSyncSnapshot } from '@/lib/ownerSync'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const role = (session.user as any).role
  if (role !== 'admin') {
    return NextResponse.json({ error: 'Only the restaurant manager desktop can export sync data.' }, { status: 403 })
  }

  const restaurant = await prisma.restaurant.findUnique({
    where: { ownerId: session.user.id },
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
      where: { userId: session.user.id, saleDate: { gte: lookbackStart } },
      include: { dish: { select: { name: true } } },
      orderBy: { saleDate: 'desc' },
    }),
    prisma.shift.findMany({
      where: { userId: session.user.id, date: { gte: lookbackStart } },
      orderBy: { date: 'desc' },
    }),
    prisma.wasteLog.findMany({
      where: { userId: session.user.id, date: { gte: lookbackStart } },
      orderBy: { date: 'desc' },
    }),
    prisma.transaction.findMany({
      where: {
        userId: session.user.id,
        date: { gte: lookbackStart },
        category: { is: { type: 'expense' } },
      },
      include: {
        account: { select: { name: true } },
        category: { select: { name: true, type: true } },
      },
      orderBy: { date: 'desc' },
    }),
    prisma.transaction.findMany({
      where: { userId: session.user.id, date: { gte: lookbackStart } },
      include: {
        account: { select: { name: true } },
        category: { select: { name: true, type: true } },
      },
      orderBy: { date: 'desc' },
      take: 300,
    }),
    prisma.inventoryItem.findMany({
      where: { userId: session.user.id, inventoryType: 'ingredient' },
      orderBy: { name: 'asc' },
    }),
    prisma.inventoryPurchase.findMany({
      where: { userId: session.user.id, purchasedAt: { gte: lookbackStart } },
      orderBy: { purchasedAt: 'desc' },
    }),
    prisma.dishSaleIngredient.findMany({
      where: {
        dishSale: {
          userId: session.user.id,
          saleDate: { gte: lookbackStart },
        },
      },
      include: { dishSale: { select: { saleDate: true } } },
    }),
    prisma.pendingOrder.count({
      where: { restaurantId: restaurant.id, status: { in: ['new', 'in_kitchen'] } },
    }),
    prisma.dishSale.findFirst({ where: { userId: session.user.id }, orderBy: { saleDate: 'desc' }, select: { saleDate: true } }),
    prisma.transaction.findFirst({ where: { userId: session.user.id }, orderBy: { date: 'desc' }, select: { date: true } }),
    prisma.pendingOrder.findFirst({ where: { restaurantId: restaurant.id }, orderBy: { addedAt: 'desc' }, select: { addedAt: true } }),
    prisma.inventoryPurchase.findFirst({ where: { userId: session.user.id }, orderBy: { purchasedAt: 'desc' }, select: { purchasedAt: true } }),
    prisma.wasteLog.findFirst({ where: { userId: session.user.id }, orderBy: { date: 'desc' }, select: { date: true } }),
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