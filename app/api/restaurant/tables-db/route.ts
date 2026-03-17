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

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const restaurantId = await getRestaurantId(session.user.id)
  if (!restaurantId) return NextResponse.json([])

  const tables = await prisma.restaurantTable.findMany({
    where: { restaurantId },
    orderBy: { createdAt: 'asc' }
  })
  return NextResponse.json(tables)
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const restaurantId = await getRestaurantId(session.user.id)
  if (!restaurantId) return NextResponse.json({ error: 'No restaurant found' }, { status: 400 })

  const { name, seats, status } = await req.json()
  if (!name?.trim()) return NextResponse.json({ error: 'Name required' }, { status: 400 })

  const table = await prisma.restaurantTable.create({
    data: { restaurantId, name: name.trim(), seats: Number(seats) || 4, status: status || 'available' }
  })
  return NextResponse.json(table, { status: 201 })
}
