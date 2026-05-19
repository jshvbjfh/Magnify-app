import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { enqueueSyncChange } from '@/lib/syncOutbox'

/** DELETE /api/restaurant/waiters/[id]
 *  Handles both waiter Staff accounts and owner User accounts,
 *  scoped to the current restaurant to prevent cross-restaurant leaks.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!['admin', 'owner'].includes(String((session.user as any).role))) {
    return NextResponse.json({ error: 'Admin only' }, { status: 403 })
  }

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId || !context.branchId) {
    return NextResponse.json({ error: 'No restaurant branch' }, { status: 400 })
  }

  const { id } = await params

  // Try waiter Staff first — scoped by restaurantId to prevent cross-restaurant leaks
  const waiterStaff = await prisma.staff.findFirst({
    where: { id, restaurantId: context.restaurantId, role: 'waiter' },
  })
  if (waiterStaff) {
    await prisma.staff.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    })
    await enqueueSyncChange(prisma, {
      restaurantId: context.restaurantId,
      branchId: context.branchId,
      entityType: 'staff',
      entityId: id,
      operation: 'delete',
      payload: { id },
    })
    return NextResponse.json({ ok: true })
  }

  // Try owner User — scoped to this restaurant via ownerId relation
  const ownerUser = await prisma.user.findFirst({
    where: { id, role: 'owner', restaurants: { some: { id: context.restaurantId } } },
  })
  if (!ownerUser) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  await prisma.user.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
