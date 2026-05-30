import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { ACTIVE_RESTAURANT_ORDER_STATUSES } from '@/lib/restaurantOrders'

const VALID_STATUSES = ['new', 'in_kitchen', 'ready']

/** PATCH /api/restaurant/pending/[id] — update the status of a pending order */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

  const body = await req.json()
  const { status } = body

  if (!VALID_STATUSES.includes(status)) {
    return NextResponse.json({ error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` }, { status: 400 })
  }

  const { id } = await params
  const orderItem = await prisma.orderItem.findFirst({
    where: { id, order: { restaurantId: context.restaurantId, branchId: context.branchId, status: { in: [...ACTIVE_RESTAURANT_ORDER_STATUSES] } }, status: 'ACTIVE' },
  })
  if (!orderItem) return NextResponse.json({ error: 'Order not found' }, { status: 404 })

  const updated = await prisma.orderItem.update({
    where: { id },
    data: {
      kitchenStatus: status,
      ...(status === 'ready' ? { readyAt: new Date() } : {}),
    },
  })
  return NextResponse.json(updated)
}
