import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { enqueueSyncChange } from '@/lib/syncOutbox'

export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null

  if (!restaurantId || !branchId) return NextResponse.json([])

  const { searchParams } = new URL(req.url)
  const from = searchParams.get('from')
  const to = searchParams.get('to')

  const shifts = await prisma.employeeShift.findMany({
    where: {
      restaurantId,
      branchId,
      ...(from && to && { clockInAt: { gte: new Date(from), lte: new Date(to) } }),
    },
    include: { staff: { select: { name: true } } },
    orderBy: { clockInAt: 'desc' },
  })
  return NextResponse.json(shifts)
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

  const { staffId, date, durationMins, notes } = await req.json()
  if (!staffId || !date) {
    return NextResponse.json({ error: 'staffId and date are required' }, { status: 400 })
  }

  const shiftDate = new Date(date)
  if (Number.isNaN(shiftDate.getTime())) {
    return NextResponse.json({ error: 'Invalid date' }, { status: 400 })
  }

  const staff = await prisma.staff.findFirst({
    where: { id: staffId, restaurantId: context.restaurantId },
  })
  if (!staff) return NextResponse.json({ error: 'Staff not found' }, { status: 404 })

  const shift = await prisma.employeeShift.create({
    data: {
      restaurantId: context.restaurantId,
      branchId: context.branchId,
      staffId,
      clockInAt: shiftDate,
      durationMins: durationMins ? Number(durationMins) : null,
      notes: notes || null,
    },
    include: { staff: { select: { name: true } } },
  })

  await enqueueSyncChange(prisma, {
    restaurantId: context.restaurantId,
    branchId: context.branchId,
    entityType: 'employeeShift',
    entityId: shift.id,
    operation: 'upsert',
    payload: shift,
  })

  return NextResponse.json(shift, { status: 201 })
}
