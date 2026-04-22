import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { hash } from 'bcryptjs'
import { provisionRestaurantAccountInCloud } from '@/lib/cloudRestaurantAccountProvision'
import { ensureRestaurantForOwner, getRestaurantContextForUser } from '@/lib/restaurantAccess'

async function requireAdmin() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) throw new Error('Unauthorized')
  const user = session.user as any
  if (user.role !== 'admin') throw new Error('Admin only')
  return {
    id: session.user.id,
    email: typeof session.user.email === 'string' ? session.user.email.trim().toLowerCase() : '',
  }
}

async function getOrCreateRestaurant(ownerId: string) {
  return ensureRestaurantForOwner(ownerId)
}

function isLocalFirstDesktopMode() {
  return String(process.env.ELECTRON_DATA_MODE ?? '').trim().toLowerCase() === 'local-first'
}

function canProvisionToCloud() {
  const { getCanonicalCloudAppUrl } = require('@/lib/cloudAuthBridge')
  return isLocalFirstDesktopMode() || Boolean(getCanonicalCloudAppUrl())
}

/** GET /api/restaurant/kitchen — list all kitchen accounts for this restaurant */
export async function GET() {
  try {
    const admin = await requireAdmin()
    const restaurant = await getOrCreateRestaurant(admin.id)
    const adminContext = await getRestaurantContextForUser(admin.id)
    if (!adminContext?.branchId || adminContext.restaurantId !== restaurant.id) {
      return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })
    }

    const kitchenUsers = await prisma.user.findMany({
      where: { restaurantId: restaurant.id, branchId: adminContext.branchId, role: 'kitchen' },
      select: { id: true, name: true, email: true, role: true, createdAt: true },
    })

    return NextResponse.json({ kitchenUsers, restaurant })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: e.message === 'Unauthorized' ? 401 : 403 })
  }
}

/** POST /api/restaurant/kitchen — create a kitchen account */
export async function POST(req: Request) {
  try {
    const admin = await requireAdmin()
    const restaurant = await getOrCreateRestaurant(admin.id)
    const adminContext = await getRestaurantContextForUser(admin.id)
    if (!adminContext?.branchId || adminContext.restaurantId !== restaurant.id) {
      return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })
    }

    const { name, email, password } = await req.json()
    if (!name?.trim() || !email?.trim() || !password?.trim()) {
      return NextResponse.json({ error: 'name, email, and password are required' }, { status: 400 })
    }

    const existing = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } })
    if (existing) {
      return NextResponse.json({ error: 'Email already in use' }, { status: 409 })
    }

    if (canProvisionToCloud()) {
      const remoteProvision = await provisionRestaurantAccountInCloud({
        restaurant,
        role: 'kitchen',
        name: name.trim(),
        email: email.trim().toLowerCase(),
        password,
        adminEmail: admin.email,
      })

      if (!remoteProvision.ok) {
        if (isLocalFirstDesktopMode()) {
          return NextResponse.json({ error: remoteProvision.error }, { status: remoteProvision.status })
        }
      }
    }

    const hashed = await hash(password, 12)
    const kitchenUser = await prisma.user.create({
      data: {
        name: name.trim(),
        email: email.trim().toLowerCase(),
        password: hashed,
        role: 'kitchen',
        businessType: 'restaurant',
        restaurantId: restaurant.id,
        branchId: adminContext.branchId,
      },
      select: { id: true, name: true, email: true, role: true, createdAt: true },
    })

    return NextResponse.json({ kitchenUser }, { status: 201 })
  } catch (e: any) {
    const status = e.message === 'Unauthorized' ? 401 : e.message === 'Admin only' ? 403 : 500
    return NextResponse.json({ error: e.message }, { status })
  }
}
