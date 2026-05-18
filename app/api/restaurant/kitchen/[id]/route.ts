import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'

/** DELETE /api/restaurant/kitchen/[id] — remove a kitchen staff account */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if ((session.user as any).role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId) return NextResponse.json({ error: 'No restaurant found' }, { status: 400 })

  const { id } = await params
  const kitchenStaff = await prisma.staff.findFirst({
    where: { id, restaurantId: context.restaurantId, role: 'kitchen' },
  })
  if (!kitchenStaff) return NextResponse.json({ error: 'Kitchen account not found' }, { status: 404 })

  await prisma.staff.update({
    where: { id },
    data: { deletedAt: new Date(), isActive: false },
  })
  return NextResponse.json({ ok: true })
}
