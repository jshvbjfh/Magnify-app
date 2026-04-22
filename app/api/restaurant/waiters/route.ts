import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { Prisma } from '@prisma/client'
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
  // Provision to cloud whenever a cloud URL is available, not only in local-first desktop mode
  const { getCanonicalCloudAppUrl } = require('@/lib/cloudAuthBridge')
  return isLocalFirstDesktopMode() || Boolean(getCanonicalCloudAppUrl())
}

/** GET /api/restaurant/waiters — list all waiters for this restaurant */
export async function GET() {
  try {
    const admin = await requireAdmin()
    const restaurant = await getOrCreateRestaurant(admin.id)
    const adminContext = await getRestaurantContextForUser(admin.id)
    if (!adminContext?.branchId || adminContext.restaurantId !== restaurant.id) {
      return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })
    }

    const waiters = await prisma.user.findMany({
      where: { restaurantId: restaurant.id, branchId: adminContext.branchId },
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
    const admin = await requireAdmin()
    const restaurant = await getOrCreateRestaurant(admin.id)
    const adminContext = await getRestaurantContextForUser(admin.id)
    if (!adminContext?.branchId || adminContext.restaurantId !== restaurant.id) {
      return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })
    }

    const { name, email, password, role: reqRole, syncTargetUrl, syncEmail, syncPassword } = await req.json()
    if (!name?.trim() || !email?.trim() || !password?.trim()) {
      return NextResponse.json({ error: 'name, email, and password are required' }, { status: 400 })
    }
    const accountRole = reqRole === 'owner' ? 'owner' : 'waiter'
    const normalizedEmail = email.trim().toLowerCase()
    const trimmedName = name.trim()

    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } })
    const canUpdateExistingOwner = Boolean(
      existing
      && accountRole === 'owner'
      && existing.role === 'owner'
      && existing.restaurantId === restaurant.id
    )

    if (existing && !canUpdateExistingOwner) {
      return NextResponse.json({ error: 'Email already in use' }, { status: 409 })
    }

    if (canProvisionToCloud()) {
      const remoteProvision = await provisionRestaurantAccountInCloud({
        restaurant,
        role: accountRole,
        name: trimmedName,
        email: normalizedEmail,
        password,
        syncTargetUrl,
        syncEmail,
        syncPassword,
        adminEmail: admin.email,
      })

      if (!remoteProvision.ok) {
        // In non-local-first mode, cloud provisioning failure is non-blocking
        if (isLocalFirstDesktopMode()) {
          return NextResponse.json({ error: remoteProvision.error }, { status: remoteProvision.status })
        }
      }
    }

    const hashed = await hash(password, 12)
    let updated = canUpdateExistingOwner
    let waiter

    try {
      waiter = canUpdateExistingOwner
        ? await prisma.user.update({
            where: { id: existing!.id },
            data: {
              name: trimmedName,
              password: hashed,
              role: accountRole,
              businessType: 'restaurant',
              restaurantId: restaurant.id,
              branchId: adminContext.branchId,
            },
            select: { id: true, name: true, email: true, role: true, createdAt: true },
          })
        : await prisma.user.create({
            data: {
              name: trimmedName,
              email: normalizedEmail,
              password: hashed,
              role: accountRole,
              businessType: 'restaurant',
              restaurantId: restaurant.id,
              branchId: adminContext.branchId,
            },
            select: { id: true, name: true, email: true, role: true, createdAt: true },
          })
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error
      }

      const existingAfterConflict = await prisma.user.findUnique({
        where: { email: normalizedEmail },
        select: { id: true, role: true, restaurantId: true },
      })

      if (!existingAfterConflict || existingAfterConflict.role !== accountRole || existingAfterConflict.restaurantId !== restaurant.id) {
        throw error
      }

      waiter = await prisma.user.update({
        where: { id: existingAfterConflict.id },
        data: {
          name: trimmedName,
          password: hashed,
          role: accountRole,
          businessType: 'restaurant',
          restaurantId: restaurant.id,
          branchId: adminContext.branchId,
        },
        select: { id: true, name: true, email: true, role: true, createdAt: true },
      })
      updated = true
    }

    return NextResponse.json({ waiter, updated }, { status: updated ? 200 : 201 })
  } catch (e: any) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return NextResponse.json({ error: 'Email already in use' }, { status: 409 })
    }
    const status = e.message === 'Unauthorized' ? 401 : e.message === 'Admin only' ? 403 : 500
    return NextResponse.json({ error: e.message }, { status })
  }
}
