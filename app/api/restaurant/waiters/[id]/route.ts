import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'

/** DELETE /api/restaurant/waiters/[id] — remove a waiter, kitchen, or owner account */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if ((session.user as any).role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant branch' }, { status: 400 })

  const { id } = await params
  const staffAccount = await prisma.user.findFirst({ where: { id, restaurantId: context.restaurantId } })
  if (!staffAccount) return NextResponse.json({ error: 'Staff account not found' }, { status: 404 })

  if (staffAccount.role === 'admin') {
    return NextResponse.json({ error: 'Cannot delete admin accounts from the staff list' }, { status: 403 })
  }

  if (!['waiter', 'kitchen', 'owner'].includes(staffAccount.role)) {
    return NextResponse.json({ error: 'Unsupported staff account role' }, { status: 403 })
  }

  if (staffAccount.role !== 'owner' && staffAccount.branchId !== context.branchId) {
    return NextResponse.json({ error: 'Staff account not found' }, { status: 404 })
  }

  await prisma.user.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
