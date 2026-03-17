import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

/** DELETE /api/restaurant/waiters/[id] — remove a waiter account */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if ((session.user as any).role !== 'admin') return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const restaurant = await prisma.restaurant.findUnique({ where: { ownerId: session.user.id } })
  if (!restaurant) return NextResponse.json({ error: 'No restaurant' }, { status: 400 })

  const { id } = await params
  // Ensure waiter belongs to this restaurant
  const waiter = await prisma.user.findFirst({ where: { id, restaurantId: restaurant.id } })
  if (!waiter) return NextResponse.json({ error: 'Waiter not found' }, { status: 404 })

  await prisma.user.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
