import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { hash } from 'bcryptjs'
import { provisionRestaurantAccountInCloud } from '@/lib/cloudRestaurantAccountProvision'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'

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

function isLocalFirstDesktopMode() {
  return String(process.env.ELECTRON_DATA_MODE ?? '').trim().toLowerCase() === 'local-first'
}

function canProvisionToCloud() {
  const { getCanonicalCloudAppUrl } = require('@/lib/cloudAuthBridge')
  return isLocalFirstDesktopMode() || Boolean(getCanonicalCloudAppUrl())
}

/** GET /api/restaurant/kitchen — list all kitchen staff for this restaurant */
export async function GET() {
  try {
    const admin = await requireAdmin()
    const adminContext = await getRestaurantContextForUser(admin.id)
    const restaurant = adminContext?.restaurant
    if (!restaurant) return NextResponse.json({ error: 'No restaurant is linked to this account' }, { status: 409 })

    const kitchenStaff = await prisma.staff.findMany({
      where: { restaurantId: restaurant.id, role: 'kitchen', deletedAt: null },
      select: { id: true, name: true, username: true, role: true, createdAt: true },
    })

    return NextResponse.json({ kitchenUsers: kitchenStaff, restaurant })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: e.message === 'Unauthorized' ? 401 : 403 })
  }
}

/** POST /api/restaurant/kitchen — create a kitchen staff account */
export async function POST(req: Request) {
  try {
    const admin = await requireAdmin()
    const adminContext = await getRestaurantContextForUser(admin.id)
    const restaurant = adminContext?.restaurant
    if (!restaurant) return NextResponse.json({ error: 'No restaurant is linked to this account' }, { status: 409 })
    if (!adminContext.branchId) {
      return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })
    }

    const { name, username, password, syncTargetUrl, syncEmail, syncPassword } = await req.json()
    if (!name?.trim() || !username?.trim() || !password?.trim()) {
      return NextResponse.json({ error: 'name, username, and password are required' }, { status: 400 })
    }
    let cloudProvisionWarning: string | null = null

    const existing = await prisma.staff.findFirst({
      where: { restaurantId: restaurant.id, username: username.trim().toLowerCase() },
    })
    if (existing) {
      return NextResponse.json({ error: 'Username already in use' }, { status: 409 })
    }

    if (canProvisionToCloud()) {
      const remoteProvision = await provisionRestaurantAccountInCloud({
        restaurant,
        role: 'kitchen',
        name: name.trim(),
        email: username.trim().toLowerCase(),
        password,
        branchId: adminContext.branchId,
        syncTargetUrl,
        syncEmail,
        syncPassword,
        adminEmail: admin.email,
      })
      if (!remoteProvision.ok) {
        cloudProvisionWarning = remoteProvision.error
      }
    }

    const hashed = await hash(password, 12)
    const kitchenStaff = await prisma.staff.create({
      data: {
        restaurantId: restaurant.id,
        name: name.trim(),
        username: username.trim().toLowerCase(),
        password: hashed,
        role: 'kitchen',
        branches: {
          create: { branchId: adminContext.branchId },
        },
      },
      select: { id: true, name: true, username: true, role: true, createdAt: true },
    })

    return NextResponse.json({ kitchenUser: kitchenStaff, cloudProvisionWarning }, { status: 201 })
  } catch (e: any) {
    const status = e.message === 'Unauthorized' ? 401 : e.message === 'Admin only' ? 403 : 500
    return NextResponse.json({ error: e.message }, { status })
  }
}
