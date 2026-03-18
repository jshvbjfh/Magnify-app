import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { buildOwnerDashboardPayload, buildOwnerSyncSnapshot, parseOwnerDashboardRange, type OwnerSyncSnapshot } from '@/lib/ownerSync'

async function resolveRestaurantAccess() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const userRole = (session.user as any).role
  const userId = session.user.id

  if (userRole === 'owner') {
    const restaurantId = (session.user as any).restaurantId
    if (!restaurantId) return { error: NextResponse.json({ error: 'No restaurant linked to this owner account' }, { status: 403 }) }

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { id: true, name: true, ownerId: true },
    })

    if (!restaurant) return { error: NextResponse.json({ error: 'Restaurant not found' }, { status: 404 }) }
    return { restaurant, managerUserId: restaurant.ownerId }
  }

  if (userRole === 'admin') {
    const restaurant = await prisma.restaurant.findUnique({
      where: { ownerId: userId },
      select: { id: true, name: true, ownerId: true },
    })

    if (!restaurant) return { error: NextResponse.json({ error: 'Restaurant not set up yet' }, { status: 404 }) }
    return { restaurant, managerUserId: restaurant.ownerId }
  }

  return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) }
}

export async function GET(req: Request) {
  const access = await resolveRestaurantAccess()
  if ('error' in access) return access.error

  const { restaurant, managerUserId } = access
  const { searchParams } = new URL(req.url)
  const range = parseOwnerDashboardRange(searchParams)

  const syncedSnapshot = await prisma.financialStatement.findFirst({
    where: { type: `owner_sync_snapshot:${restaurant.id}` },
    orderBy: { updatedAt: 'desc' },
  })

  if (syncedSnapshot?.data) {
    try {
      const snapshot = JSON.parse(syncedSnapshot.data) as OwnerSyncSnapshot
      if (snapshot?.version === 1 && snapshot.restaurantId === restaurant.id) {
        return NextResponse.json(buildOwnerDashboardPayload(snapshot, range, 'snapshot'))
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
      where: { userId: managerUserId },
      include: { dish: { select: { name: true } } },
      orderBy: { saleDate: 'desc' },
      take: 5000,
    }),
    prisma.shift.findMany({
      where: { userId: managerUserId },
      orderBy: { date: 'desc' },
      take: 2000,
    }),
    prisma.wasteLog.findMany({
      where: { userId: managerUserId },
      orderBy: { date: 'desc' },
      take: 2000,
    }),
    prisma.transaction.findMany({
      where: {
        userId: managerUserId,
        category: { is: { type: 'expense' } },
      },
      include: {
        account: { select: { name: true } },
        category: { select: { name: true, type: true } },
      },
      orderBy: { date: 'desc' },
      take: 4000,
    }),
    prisma.transaction.findMany({
      where: { userId: managerUserId },
      include: {
        account: { select: { name: true } },
        category: { select: { name: true, type: true } },
      },
      orderBy: { date: 'desc' },
      take: 1000,
    }),
    prisma.inventoryItem.findMany({
      where: { userId: managerUserId, inventoryType: 'ingredient' },
      orderBy: { name: 'asc' },
    }),
    prisma.inventoryPurchase.findMany({
      where: { userId: managerUserId },
      orderBy: { purchasedAt: 'desc' },
      take: 3000,
    }),
    prisma.dishSaleIngredient.findMany({
      where: { dishSale: { userId: managerUserId } },
      include: { dishSale: { select: { saleDate: true } } },
      take: 5000,
    }),
    prisma.pendingOrder.count({
      where: { restaurantId: restaurant.id, status: { in: ['new', 'in_kitchen'] } },
    }),
    prisma.dishSale.findFirst({ where: { userId: managerUserId }, orderBy: { saleDate: 'desc' }, select: { saleDate: true } }),
    prisma.transaction.findFirst({ where: { userId: managerUserId }, orderBy: { date: 'desc' }, select: { date: true } }),
    prisma.pendingOrder.findFirst({ where: { restaurantId: restaurant.id }, orderBy: { addedAt: 'desc' }, select: { addedAt: true } }),
    prisma.inventoryPurchase.findFirst({ where: { userId: managerUserId }, orderBy: { purchasedAt: 'desc' }, select: { purchasedAt: true } }),
    prisma.wasteLog.findFirst({ where: { userId: managerUserId }, orderBy: { date: 'desc' }, select: { date: true } }),
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

  return NextResponse.json(buildOwnerDashboardPayload(snapshot, range, 'live'))
}
