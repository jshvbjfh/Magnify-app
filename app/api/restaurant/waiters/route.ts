import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { hash } from 'bcryptjs'
import { ensureRestaurantForOwner } from '@/lib/restaurantAccess'

async function requireAdmin() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) throw new Error('Unauthorized')
  const user = session.user as any
  if (user.role !== 'admin') throw new Error('Admin only')
  return session.user.id
}

async function getOrCreateRestaurant(ownerId: string) {
  return ensureRestaurantForOwner(ownerId)
}

/** GET /api/restaurant/waiters — list all waiters for this restaurant */
export async function GET() {
  try {
    const adminId = await requireAdmin()
    const restaurant = await getOrCreateRestaurant(adminId)

    const waiters = await prisma.user.findMany({
      where: { restaurantId: restaurant.id },
      select: { id: true, name: true, email: true, role: true, createdAt: true }
    })

    return NextResponse.json({ waiters, restaurant })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: e.message === 'Unauthorized' ? 401 : 403 })
  }
}

/** POST /api/restaurant/waiters — create a waiter account */
export async function POST(req: Request) {
  try {
    const adminId = await requireAdmin()
    const restaurant = await getOrCreateRestaurant(adminId)

    const { name, email, password, role: reqRole } = await req.json()
    if (!name?.trim() || !email?.trim() || !password?.trim()) {
      return NextResponse.json({ error: 'name, email, and password are required' }, { status: 400 })
    }
    const accountRole = reqRole === 'owner' ? 'owner' : 'waiter'

    const existing = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } })
    if (existing) {
      return NextResponse.json({ error: 'Email already in use' }, { status: 409 })
    }

    const hashed = await hash(password, 12)
    const waiter = await prisma.user.create({
      data: {
        name: name.trim(),
        email: email.trim().toLowerCase(),
        password: hashed,
        role: accountRole,
        businessType: 'restaurant',
        restaurantId: restaurant.id,
      },
      select: { id: true, name: true, email: true, role: true, createdAt: true }
    })

    return NextResponse.json({ waiter }, { status: 201 })
  } catch (e: any) {
    const status = e.message === 'Unauthorized' ? 401 : e.message === 'Admin only' ? 403 : 500
    return NextResponse.json({ error: e.message }, { status })
  }
}
