import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { enqueueSyncChange } from '@/lib/syncOutbox'

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

  const { id } = await params
  const ALLOWED_ROLES = ['Chef', 'Sous Chef', 'Waiter', 'Cashier', 'Manager', 'Host', 'Dishwasher', 'Bartender']

  const data = await req.json()

  if (data.role !== undefined && !ALLOWED_ROLES.some(r => r.toLowerCase() === String(data.role).toLowerCase())) {
    return NextResponse.json({ error: `Invalid role. Allowed roles: ${ALLOWED_ROLES.join(', ')}` }, { status: 400 })
  }

  const updateData: Record<string, unknown> = {
    ...(data.name !== undefined && { name: data.name }),
    ...(data.role !== undefined && { role: data.role }),
    ...(data.phone !== undefined && { phone: data.phone }),
    ...(data.isActive !== undefined && { isActive: data.isActive }),
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

  const context = await getRestaurantContextForUser(session.user.id)
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
