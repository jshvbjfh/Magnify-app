import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

/** DELETE /api/restaurant/kitchen/[id] — remove a kitchen account */
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if ((session.user as any).role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const restaurant = await prisma.restaurant.findUnique({ where: { ownerId: session.user.id } })
  if (!restaurant) return NextResponse.json({ error: 'No restaurant' }, { status: 400 })

  const kitchenUser = await prisma.user.findFirst({
    where: { id: params.id, restaurantId: restaurant.id, role: 'kitchen' },
  })
  if (!kitchenUser) return NextResponse.json({ error: 'Kitchen account not found' }, { status: 404 })

  await prisma.user.delete({ where: { id: params.id } })
  return NextResponse.json({ ok: true })
}
