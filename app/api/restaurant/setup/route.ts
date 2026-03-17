import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

function makeJoinCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

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

  let restaurant = await prisma.restaurant.findUnique({ where: { ownerId: userId } })

  if (!restaurant) {
    // Auto-create with their name as restaurant name
    const user = await prisma.user.findUnique({ where: { id: userId } })
    let code = makeJoinCode()
    // ensure uniqueness
    while (await prisma.restaurant.findUnique({ where: { joinCode: code } })) {
      code = makeJoinCode()
    }
    restaurant = await prisma.restaurant.create({
      data: { name: user?.name ? `${user.name}'s Restaurant` : 'My Restaurant', ownerId: userId, joinCode: code }
    })
  }

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

  const restaurant = await prisma.restaurant.upsert({
    where: { ownerId: userId },
    update: updateData,
    create: {
      name: name || 'My Restaurant',
      billHeader: billHeader ?? '',
      ownerId: userId,
      joinCode: makeJoinCode()
    }
  })

  return NextResponse.json({ restaurant })
}
