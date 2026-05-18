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
  if (role !== 'admin' && role !== 'owner') {
    return NextResponse.json({ error: 'Only the restaurant manager or owner can export sync data.' }, { status: 403 })
  }

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId) {
    return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 })
  }

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
    wasteLogs,
    ingredients,
    purchases,
    ingredientUsage,
    latestSale,
    latestPurchase,
    latestWaste,
  ] = await Promise.all([
    prisma.dishSale.findMany({
      where: {
        restaurantId,
        ...(branchId ? { branchId } : {}),
        saleDate: { gte: lookbackStart },
      },
      include: { dish: { select: { name: true } } },
      orderBy: { saleDate: 'desc' },
    }),
    prisma.wasteLog.findMany({
      where: {
        restaurantId,
        ...(branchId ? { branchId } : {}),
        date: { gte: lookbackStart },
      },
      orderBy: { date: 'desc' },
    }),
    prisma.inventoryItem.findMany({
      where: {
        restaurantId,
        ...(branchId ? { branchId } : {}),
      },
      orderBy: { name: 'asc' },
    }),
    prisma.inventoryPurchase.findMany({
      where: {
        restaurantId,
        ...(branchId ? { branchId } : {}),
        purchasedAt: { gte: lookbackStart },
      },
      orderBy: { purchasedAt: 'desc' },
    }),
    prisma.dishSaleIngredient.findMany({
      where: {
        dishSale: {
          restaurantId,
          ...(branchId ? { branchId } : {}),
          saleDate: { gte: lookbackStart },
        },
      },
      include: { dishSale: { select: { saleDate: true } } },
    }),
    prisma.dishSale.findFirst({ where: { restaurantId, ...(branchId ? { branchId } : {}) }, orderBy: { saleDate: 'desc' }, select: { saleDate: true } }),
    prisma.inventoryPurchase.findFirst({ where: { restaurantId, ...(branchId ? { branchId } : {}) }, orderBy: { purchasedAt: 'desc' }, select: { purchasedAt: true } }),
    prisma.wasteLog.findFirst({ where: { restaurantId, ...(branchId ? { branchId } : {}) }, orderBy: { date: 'desc' }, select: { date: true } }),
  ])

  const snapshot = buildOwnerSyncSnapshot({
    restaurantId: restaurant.id,
    restaurantName: restaurant.name,
    activeOrders: 0,
    sales,
    shifts: [],
    wasteLogs,
    expenseTransactions: [],
    transactions: [],
    ingredients,
    purchases,
    ingredientUsage,
    activity: {
      lastSaleAt: latestSale?.saleDate ?? null,
      lastTransactionAt: null,
      lastPendingOrderAt: null,
      lastPurchaseAt: latestPurchase?.purchasedAt ?? null,
      lastWasteAt: latestWaste?.date ?? null,
    },
  })

  return NextResponse.json({ snapshot })
}
