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
  qrOrderingMode: true,
  fifoEnabled: true,
  fifoConfiguredAt: true,
  fifoCutoverAt: true,
  syncRestaurantId: true,
} as const

/** GET — fetch the admin's restaurant (creates one if missing) */
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const userId = session.user.id

  const context = await getRestaurantContextForUser(userId)
  const targetRestaurantId = context?.restaurantId ?? (await ensureRestaurantForOwner(userId)).id
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: targetRestaurantId },
    select: settingsRestaurantSelect,
  })
  if (!restaurant) return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 })

  const waiters = await prisma.user.findMany({
    where: { restaurantId: restaurant.id },
    select: { id: true, name: true, email: true, role: true, createdAt: true }
  })

  return NextResponse.json({ restaurant, waiters })
}

/** POST — update restaurant settings */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const userId = session.user.id
  const { name, billHeader, qrOrderingMode, fifoEnabled } = await req.json()

  const context = await getRestaurantContextForUser(userId)
  const targetRestaurantId = context?.restaurantId ?? (await ensureRestaurantForOwner(userId)).id
  const currentRestaurant = context?.restaurant ?? await prisma.restaurant.findUnique({
    where: { id: targetRestaurantId },
    select: {
      id: true,
      syncRestaurantId: true,
      fifoEnabled: true,
      fifoConfiguredAt: true,
      fifoCutoverAt: true,
    },
  })

  if (!currentRestaurant) {
    return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 })
  }

  const updateData: { name?: string; billHeader?: string; qrOrderingMode?: string; fifoEnabled?: boolean; fifoConfiguredAt?: Date; fifoCutoverAt?: Date } = {}
  if (name      !== undefined) updateData.name       = name      || 'My Restaurant'
  if (billHeader !== undefined) updateData.billHeader = billHeader ?? ''
  if (qrOrderingMode === 'order' || qrOrderingMode === 'view_only' || qrOrderingMode === 'disabled') updateData.qrOrderingMode = qrOrderingMode
  if (typeof fifoEnabled === 'boolean') {
    if (!fifoEnabled) {
      return NextResponse.json({ error: 'This app now enforces strict FIFO. Average Cost is no longer supported.' }, { status: 409 })
    }

    const fifoAvailable = getRestaurantFifoAvailability(currentRestaurant)

    if (currentRestaurant.fifoCutoverAt) {
      updateData.fifoEnabled = true
    } else {
      if (!fifoAvailable) {
        return NextResponse.json({ error: 'FIFO is not available for this restaurant in the current build.' }, { status: 409 })
      }

      const integrity = await getRestaurantInventoryIntegrity(prisma, {
        billingUserId: context?.billingUserId ?? userId,
        restaurantId: targetRestaurantId,
      })

      if (integrity.summary.mismatchCount > 0) {
        return NextResponse.json({ error: 'This app uses strict FIFO. Preview and apply FIFO reconciliation before recording cutover for this restaurant.' }, { status: 409 })
      }

      updateData.fifoEnabled = true
      updateData.fifoCutoverAt = new Date()
    }

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
