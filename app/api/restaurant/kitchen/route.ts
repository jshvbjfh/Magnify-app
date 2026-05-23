import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { hash } from 'bcryptjs'
import { provisionRestaurantAccountInCloud } from '@/lib/cloudRestaurantAccountProvision'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { ensureRestaurantStaffLoginUser } from '@/lib/restaurantStaffUsers'

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
  // Only needed for local-first Electron: the local SQLite DB must replicate accounts to
  // the remote cloud server. On Vercel/PostgreSQL, accounts land directly in the cloud DB
  // at creation time — no separate provisioning step is needed or possible.
  return isLocalFirstDesktopMode()
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

    // Map username → email so the UI Waiter type is satisfied
    const kitchenUsers = kitchenStaff.map(s => ({
      id: s.id,
      name: s.name,
      email: s.username ?? '',
      createdAt: s.createdAt,
    }))

    return NextResponse.json({ kitchenUsers, restaurant })
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
    const branchId = adminContext.branchId

    // UI sends 'email' field; accept that as the username (with 'username' as fallback)
    const { name, email, username: usernameField, password, syncTargetUrl, syncEmail, syncPassword } = await req.json()
    const username = (email || usernameField || '').trim().toLowerCase()
    if (!name?.trim() || !username || !password?.trim()) {
      return NextResponse.json({ error: 'name, email, and password are required' }, { status: 400 })
    }
    let cloudProvisionWarning: string | null = null

    const existing = await prisma.staff.findFirst({
      where: { restaurantId: restaurant.id, username },
    })
    if (existing) {
      return NextResponse.json({ error: 'Username already in use' }, { status: 409 })
    }

    const existingLoginUser = await prisma.user.findUnique({
      where: { email: username },
      select: { id: true },
    })
    if (existingLoginUser) {
      return NextResponse.json({ error: 'Username already in use' }, { status: 409 })
    }

    if (canProvisionToCloud()) {
      const remoteProvision = await provisionRestaurantAccountInCloud({
        restaurant,
        role: 'kitchen',
        name: name.trim(),
        email: username,
        password,
        branchId,
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
    const kitchenStaff = await prisma.$transaction(async (tx) => {
      const createdStaff = await tx.staff.create({
        data: {
          restaurantId: restaurant.id,
          name: name.trim(),
          username,
          password: hashed,
          role: 'kitchen',
          branches: {
            create: { branchId },
          },
        },
        select: { id: true, name: true, username: true, role: true, isActive: true, createdAt: true },
      })

      await ensureRestaurantStaffLoginUser(tx, {
        id: createdStaff.id,
        email: username,
        name: name.trim(),
        passwordHash: hashed,
        role: 'kitchen',
        isActive: createdStaff.isActive,
      })

      return createdStaff
    })

    return NextResponse.json({ kitchenUser: kitchenStaff, cloudProvisionWarning }, { status: 201 })
  } catch (e: any) {
    const status = e.message === 'Unauthorized' ? 401 : e.message === 'Admin only' ? 403 : 500
    return NextResponse.json({ error: e.message }, { status })
  }
}
