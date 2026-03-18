import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { ensureRestaurantForOwner, findOwnedRestaurant } from '@/lib/restaurantAccess'

/** GET — fetch the admin's restaurant (creates one if missing) */
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const userId = session.user.id

  // For waiter/kitchen: resolve to their linked restaurant's owner
  const currentUser = await prisma.user.findUnique({ where: { id: userId }, select: { restaurantId: true } })
  if (currentUser?.restaurantId) {
    const restaurant = await prisma.restaurant.findUnique({ where: { id: currentUser.restaurantId } })
    if (restaurant) return NextResponse.json({ restaurant, waiters: [] })
  }

  const restaurant = await ensureRestaurantForOwner(userId)

  const waiters = await prisma.user.findMany({
    where: { restaurantId: restaurant.id },
    select: { id: true, name: true, email: true, role: true, createdAt: true }
  })

  return NextResponse.json({ restaurant, waiters })
}

/** POST — update restaurant name and/or billHeader */
export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const userId = session.user.id
  const { name, billHeader } = await req.json()

  const updateData: { name?: string; billHeader?: string } = {}
  if (name      !== undefined) updateData.name       = name      || 'My Restaurant'
  if (billHeader !== undefined) updateData.billHeader = billHeader ?? ''

  const existingRestaurant = await findOwnedRestaurant(userId)
  const restaurant = existingRestaurant
    ? await prisma.restaurant.update({
        where: { id: existingRestaurant.id },
        data: updateData,
      })
    : await prisma.restaurant.update({
        where: { id: (await ensureRestaurantForOwner(userId)).id },
        data: updateData,
      })

  return NextResponse.json({ restaurant })
}
