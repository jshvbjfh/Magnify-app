import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getRestaurantInventoryIntegrity } from '@/lib/inventoryIntegrity'
import { prisma } from '@/lib/prisma'
import { ensureRestaurantForOwner, getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { getRestaurantFifoAvailability } from '@/lib/fifoRollout'
import { enqueueSyncChange } from '@/lib/syncOutbox'

const settingsRestaurantSelect = {
  id: true,
  name: true,
  billHeader: true,
  fifoEnabled: true,
  fifoConfiguredAt: true,
  joinCode: true,
} as const

/** GET — fetch the admin's restaurant (creates one if missing) */
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const userId = session.user.id

  let context = await getRestaurantContextForUser(userId)
  let targetRestaurantId = context?.restaurantId
  if (!targetRestaurantId) {
    let created: Awaited<ReturnType<typeof ensureRestaurantForOwner>>
    try { created = await ensureRestaurantForOwner(userId) } catch (e: any) {
      if (e?.code === 'USER_NOT_FOUND') return NextResponse.json({ error: 'Session expired; please sign in again' }, { status: 409 })
      throw e
    }
    targetRestaurantId = created?.id
    context = await getRestaurantContextForUser(userId)
  }
  if (!targetRestaurantId) return NextResponse.json({ error: 'No restaurant found' }, { status: 404 })
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: targetRestaurantId },
    select: settingsRestaurantSelect,
  })
  if (!restaurant) return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 })

  if ((!context?.branchId || context.restaurantId !== restaurant.id) && targetRestaurantId === restaurant.id) {
    context = await getRestaurantContextForUser(userId)
  }

  const activeBranchId = context?.restaurantId === restaurant.id ? context.branchId : null
  const waiters = activeBranchId
    ? await prisma.staff.findMany({
        where: {
          restaurantId: restaurant.id,
          branches: { some: { branchId: activeBranchId } },
          role: { in: ['waiter', 'kitchen'] },
          deletedAt: null,
        },
        select: { id: true, name: true, username: true, role: true, createdAt: true },
      })
    : []

  return NextResponse.json({ restaurant, waiters })
}

/** POST — update restaurant settings */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const userId = session.user.id
  const { name, billHeader, fifoEnabled } = await req.json()

  const context = await getRestaurantContextForUser(userId)
  let targetRestaurantId = context?.restaurantId
  if (!targetRestaurantId) {
    let created: Awaited<ReturnType<typeof ensureRestaurantForOwner>>
    try { created = await ensureRestaurantForOwner(userId) } catch (e: any) {
      if (e?.code === 'USER_NOT_FOUND') return NextResponse.json({ error: 'Session expired; please sign in again' }, { status: 409 })
      throw e
    }
    targetRestaurantId = created?.id
  }
  if (!targetRestaurantId) return NextResponse.json({ error: 'No restaurant found' }, { status: 404 })
  const currentRestaurant = context?.restaurant ?? await prisma.restaurant.findUnique({
    where: { id: targetRestaurantId },
    select: { id: true, fifoEnabled: true, fifoConfiguredAt: true, joinCode: true },
  })

  if (!currentRestaurant) {
    return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 })
  }

  const updateData: { name?: string; billHeader?: string; fifoEnabled?: boolean; fifoConfiguredAt?: Date } = {}
  if (name       !== undefined) updateData.name       = name      || 'My Restaurant'
  if (billHeader !== undefined) updateData.billHeader = billHeader ?? ''
  if (typeof fifoEnabled === 'boolean') {
    if (!fifoEnabled) {
      return NextResponse.json({ error: 'This app now enforces strict FIFO. Average Cost is no longer supported.' }, { status: 409 })
    }

    const fifoAvailable = getRestaurantFifoAvailability(currentRestaurant)

    if (!fifoAvailable) {
      return NextResponse.json({ error: 'FIFO is not available for this restaurant in the current build.' }, { status: 409 })
    }

    const integrity = await getRestaurantInventoryIntegrity(prisma, {
      restaurantId: targetRestaurantId,
    })

    if (integrity.summary.mismatchCount > 0) {
      return NextResponse.json({ error: 'This app uses strict FIFO. Preview and apply FIFO reconciliation before recording cutover for this restaurant.' }, { status: 409 })
    }

    updateData.fifoEnabled = true
    updateData.fifoConfiguredAt = new Date()
  }

  const restaurant = await prisma.restaurant.update({
    where: { id: targetRestaurantId },
    data: updateData,
    select: settingsRestaurantSelect,
  })

  await enqueueSyncChange(prisma, {
    restaurantId: restaurant.id,
    entityType: 'restaurant',
    entityId: restaurant.id,
    operation: 'upsert',
    payload: restaurant,
  })

  return NextResponse.json({ restaurant })
}
