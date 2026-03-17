import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

async function getRestaurantId(userId: string): Promise<string | null> {
  // Waiter/kitchen link takes priority over ownership
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { restaurantId: true } })
  if (user?.restaurantId) return user.restaurantId
  // Admin: check owned restaurant
  const owned = await prisma.restaurant.findUnique({ where: { ownerId: userId } })
  return owned?.id ?? null
}

const VALID_STATUSES = ['new', 'in_kitchen', 'ready']

/** PATCH /api/restaurant/pending/[id] — update the status of a pending order */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const restaurantId = await getRestaurantId(session.user.id)
  if (!restaurantId) return NextResponse.json({ error: 'No restaurant found' }, { status: 400 })

  const body = await req.json()
  const { status } = body

  if (!VALID_STATUSES.includes(status)) {
    return NextResponse.json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` }, { status: 400 })
  }

  const { id } = await params
  const order = await prisma.pendingOrder.findFirst({
    where: { id, restaurantId },
  })
  if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 })

  const updated = await prisma.pendingOrder.update({
    where: { id },
    data: {
      status,
      ...(status === 'ready' ? { readyAt: new Date() } : {}),
    },
  })
  return NextResponse.json(updated)
}
