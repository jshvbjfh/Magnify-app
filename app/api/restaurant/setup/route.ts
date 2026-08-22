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
  billPrinterIp: true,
  billPrinterPort: true,
  qrOrderingMode: true,
  shiftsEnabled: true,
  printPaymentConfirmation: true,
  fifoEnabled: true,
  fifoConfiguredAt: true,
  joinCode: true,
} as const

// An order in any of these states still owes money or food, so the venue is
// mid-service and the shift model cannot be switched underneath it.
const UNSETTLED_ORDER_STATUSES = ['PENDING', 'OPEN', 'UNCONFIRMED'] as const

const branchPresentationSelect = {
  id: true,
  billHeader: true,
  qrMenuHeroImageUrl: true,
} as const

const branchSyncSelect = {
  id: true,
  restaurantId: true,
  name: true,
  code: true,
  isMain: true,
  isActive: true,
  billHeader: true,
  qrMenuHeroImageUrl: true,
  createdAt: true,
  updatedAt: true,
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
  const [waiters, activeBranch] = await Promise.all([
    activeBranchId
      ? prisma.staff.findMany({
          where: {
            restaurantId: restaurant.id,
            branches: { some: { branchId: activeBranchId } },
            role: { in: ['waiter', 'kitchen'] },
            deletedAt: null,
          },
          select: { id: true, name: true, username: true, role: true, createdAt: true },
        })
      : Promise.resolve([]),
    activeBranchId
      ? prisma.branch.findUnique({ where: { id: activeBranchId }, select: branchPresentationSelect })
      : Promise.resolve(null),
  ])

  // Bill template is restaurant-wide (not per-branch).
  return NextResponse.json({
    restaurant: {
      ...restaurant,
      billHeader: restaurant.billHeader ?? '',
      billHeaderInherited: false,
      qrMenuHeroImageUrl: activeBranch?.qrMenuHeroImageUrl ?? null,
    },
    waiters,
  })
}

/** POST — update restaurant settings */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const userId = session.user.id
  const body = await req.json()
  const { name, billHeader, billPrinterIp, billPrinterPort, qrOrderingMode, shiftsEnabled, fifoEnabled, printPaymentConfirmation } = body
  const qrMenuHeroImageUrl = body?.qrMenuHeroImageUrl === null
    ? null
    : typeof body?.qrMenuHeroImageUrl === 'string'
      ? body.qrMenuHeroImageUrl.trim() || null
      : undefined

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

  const restaurantUpdateData: {
    name?: string
    billHeader?: string | null
    billPrinterIp?: string | null
    billPrinterPort?: number | null
    qrOrderingMode?: 'order' | 'view_only' | 'disabled'
    shiftsEnabled?: boolean
    printPaymentConfirmation?: boolean
    fifoEnabled?: boolean
    fifoConfiguredAt?: Date
  } = {}
  if (name !== undefined) restaurantUpdateData.name = name || 'My Restaurant'
  // Bill template is restaurant-wide.
  if (billHeader !== undefined) restaurantUpdateData.billHeader = billHeader ?? null
  if (billPrinterIp !== undefined) restaurantUpdateData.billPrinterIp = typeof billPrinterIp === 'string' ? billPrinterIp.trim() || null : null
  if (billPrinterPort !== undefined) restaurantUpdateData.billPrinterPort = typeof billPrinterPort === 'number' && billPrinterPort > 0 ? billPrinterPort : null
  if (qrOrderingMode === 'order' || qrOrderingMode === 'view_only' || qrOrderingMode === 'disabled') {
    restaurantUpdateData.qrOrderingMode = qrOrderingMode
  }
  // Whether the till prints a confirmation slip on every settlement. Safe to
  // flip either way at any time: it changes what the NEXT payment prints and
  // touches nothing already recorded.
  if (typeof printPaymentConfirmation === 'boolean') {
    restaurantUpdateData.printPaymentConfirmation = printPaymentConfirmation
  }
  // Turning shifts off mid-service would strand the open orders: they are already
  // stamped with the shift, but the till would stop offering End Shift, leaving
  // them attributed to a session nobody can close. So the switch is only allowed
  // once the floor is clear, and the open shift is then closed as part of the same
  // save. Turning shifts back on is always safe and needs no such check.
  //
  // The check is scoped to the on→off *transition*, not to every save carrying
  // shiftsEnabled: false. The settings form posts the whole payload each time,
  // so a venue already running without shifts would otherwise be unable to save
  // its name or printer IP for as long as a single order sat open.
  let shiftToCloseId: string | null = null
  if (typeof shiftsEnabled === 'boolean') {
    const previous = await prisma.restaurant.findUnique({
      where: { id: targetRestaurantId },
      select: { shiftsEnabled: true },
    })
    const turningOff = previous?.shiftsEnabled !== false && !shiftsEnabled

    if (turningOff) {
      const unsettled = await prisma.restaurantOrder.count({
        where: {
          restaurantId: targetRestaurantId,
          status: { in: [...UNSETTLED_ORDER_STATUSES] },
          deletedAt: null,
        },
      })
      if (unsettled > 0) {
        return NextResponse.json(
          { error: `Settle ${unsettled} open order${unsettled === 1 ? '' : 's'} before turning shifts off.` },
          { status: 409 },
        )
      }

      const openShift = await prisma.shift.findFirst({
        where: { restaurantId: targetRestaurantId, status: 'OPEN', deletedAt: null },
        orderBy: { openedAt: 'asc' },
        select: { id: true },
      })
      shiftToCloseId = openShift?.id ?? null
    }
    restaurantUpdateData.shiftsEnabled = shiftsEnabled
  }

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

    restaurantUpdateData.fifoEnabled = true
    restaurantUpdateData.fifoConfiguredAt = new Date()
  }

  const restaurant = await prisma.restaurant.update({
    where: { id: targetRestaurantId },
    data: restaurantUpdateData,
    select: settingsRestaurantSelect,
  })

  // Close the shift the venue was running, now that shifts are off. Its orders
  // keep their shiftId and businessDate — only the session ends, so past service
  // stays reportable exactly as it was.
  if (shiftToCloseId) {
    await prisma.shift.update({
      where: { id: shiftToCloseId },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        closedByName: session.user.name ?? 'Manager',
      },
    })
  }

  // QR menu artwork remains branch-level; the bill template is saved on the restaurant above.
  const activeBranchId = context?.branchId ?? null
  if (qrMenuHeroImageUrl !== undefined && !activeBranchId) {
    return NextResponse.json({ error: 'Active station required to save QR menu artwork.' }, { status: 400 })
  }

  if (qrMenuHeroImageUrl !== undefined && activeBranchId) {
    await prisma.branch.update({
      where: { id: activeBranchId },
      data: { qrMenuHeroImageUrl },
    })
  }

  await enqueueSyncChange(prisma, {
    restaurantId: restaurant.id,
    entityType: 'restaurant',
    entityId: restaurant.id,
    operation: 'upsert',
    payload: restaurant,
  })

  const activeBranch = activeBranchId
    ? await prisma.branch.findUnique({ where: { id: activeBranchId }, select: branchSyncSelect })
    : null

  if (activeBranch && qrMenuHeroImageUrl !== undefined) {
    await enqueueSyncChange(prisma, {
      restaurantId: restaurant.id,
      entityType: 'branch',
      entityId: activeBranch.id,
      operation: 'upsert',
      payload: activeBranch,
    })
  }

  return NextResponse.json({
    restaurant: {
      ...restaurant,
      billHeader: restaurant.billHeader ?? '',
      billHeaderInherited: false,
      qrMenuHeroImageUrl: activeBranch?.qrMenuHeroImageUrl ?? null,
    },
  })
}
