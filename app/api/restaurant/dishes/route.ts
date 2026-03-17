import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Waiters see their restaurant's dishes (owned by admin)
  let queryUserId = session.user.id
  const currentUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { role: true, restaurantId: true }
  })
  if ((currentUser?.role === 'waiter' || currentUser?.role === 'kitchen') && currentUser.restaurantId) {
    const restaurant = await prisma.restaurant.findUnique({ where: { id: currentUser.restaurantId } })
    if (restaurant) queryUserId = restaurant.ownerId
  }

  const dishes = await prisma.dish.findMany({
    where: { userId: queryUserId },
    include: {
      ingredients: {
        include: { ingredient: true }
      }
    },
    orderBy: { createdAt: 'desc' }
  })
  return NextResponse.json(dishes)
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { name, sellingPrice, category } = await req.json()
  if (!name || sellingPrice == null) {
    return NextResponse.json({ error: 'name and sellingPrice are required' }, { status: 400 })
  }

  const dish = await prisma.dish.create({
    data: { userId: session.user.id, name, sellingPrice: Number(sellingPrice), category: category || null }
  })
  return NextResponse.json(dish, { status: 201 })
}
