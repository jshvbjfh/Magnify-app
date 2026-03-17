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

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const restaurantId = await getRestaurantId(session.user.id)
  if (!restaurantId) return NextResponse.json({ error: 'No restaurant' }, { status: 400 })

  const { id } = await params
  const { status, name, seats } = await req.json()

  const table = await prisma.restaurantTable.updateMany({
    where: { id, restaurantId },
    data: {
      ...(status !== undefined && { status }),
      ...(name !== undefined && { name }),
      ...(seats !== undefined && { seats: Number(seats) }),
    }
  })
  return NextResponse.json({ ok: true, count: table.count })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const restaurantId = await getRestaurantId(session.user.id)
  if (!restaurantId) return NextResponse.json({ error: 'No restaurant' }, { status: 400 })

  const { id } = await params
  await prisma.restaurantTable.deleteMany({ where: { id, restaurantId } })
  return NextResponse.json({ ok: true })
}
