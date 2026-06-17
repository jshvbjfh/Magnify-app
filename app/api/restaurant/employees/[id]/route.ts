import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { enqueueSyncChange } from '@/lib/syncOutbox'
import bcrypt from 'bcryptjs'

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

  const { id } = await params
  const ALLOWED_ROLES = ['Chef', 'Sous Chef', 'Waiter', 'Cashier', 'Manager', 'Host', 'Dishwasher', 'Bartender']

  const data = await req.json()

  if (data.role !== undefined && !ALLOWED_ROLES.some(r => r.toLowerCase() === String(data.role).toLowerCase())) {
    return NextResponse.json({ error: `Invalid role. Allowed roles: ${ALLOWED_ROLES.join(', ')}` }, { status: 400 })
  }

  let pinHash: string | null | undefined = undefined
  if (data.pin === null) {
    pinHash = null
  } else if (typeof data.pin === 'string' && data.pin.trim()) {
    if (!/^\d{4}$/.test(data.pin.trim())) {
      return NextResponse.json({ error: 'Order code must be exactly 4 digits' }, { status: 400 })
    }
    pinHash = await bcrypt.hash(data.pin.trim(), 10)
  }

  let cancellationPinHash: string | null | undefined = undefined
  if (data.cancellationPin === null) {
    cancellationPinHash = null
  } else if (typeof data.cancellationPin === 'string' && data.cancellationPin.trim()) {
    if (!/^\d{5}$/.test(data.cancellationPin.trim())) {
      return NextResponse.json({ error: 'Cancellation PIN must be exactly 5 digits' }, { status: 400 })
    }
    cancellationPinHash = await bcrypt.hash(data.cancellationPin.trim(), 10)
  }

  let rate: number | null | undefined = undefined
  if (data.hourlyRate === null || data.hourlyRate === '') {
    rate = null
  } else if (data.hourlyRate !== undefined) {
    rate = Number(data.hourlyRate)
    if (Number.isNaN(rate) || rate < 0) {
      return NextResponse.json({ error: 'Hourly rate must be a positive number' }, { status: 400 })
    }
  }

  const updateData: Record<string, unknown> = {
    ...(data.name !== undefined && { name: data.name }),
    ...(data.role !== undefined && { role: data.role }),
    ...(data.phone !== undefined && { phone: data.phone }),
    ...(data.isActive !== undefined && { isActive: data.isActive }),
    ...(pinHash !== undefined && { pin: pinHash }),
    ...(cancellationPinHash !== undefined && { cancellationPin: cancellationPinHash }),
    ...(rate !== undefined && { hourlyRate: rate }),
  }

  // username: null ensures waiter/kitchen login accounts can't be patched via this endpoint
  await prisma.staff.updateMany({
    where: { id, restaurantId: context.restaurantId, username: null },
    data: updateData,
  })

  const staff = await prisma.staff.findFirst({ where: { id, restaurantId: context.restaurantId, username: null } })
  if (staff) {
    await enqueueSyncChange(prisma, {
      restaurantId: context.restaurantId,
      branchId: context.branchId,
      entityType: 'staff',
      entityId: staff.id,
      operation: 'upsert',
      payload: staff,
    })
  }

  return NextResponse.json({ success: true })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

  const { id } = await params
  await prisma.staff.deleteMany({ where: { id, restaurantId: context.restaurantId, username: null } })

  await enqueueSyncChange(prisma, {
    restaurantId: context.restaurantId,
    branchId: context.branchId,
    entityType: 'staff',
    entityId: id,
    operation: 'delete',
    payload: { id },
  })

  return NextResponse.json({ success: true })
}
