import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { Prisma } from '@prisma/client'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { hash } from 'bcryptjs'
import { provisionRestaurantAccountInCloud } from '@/lib/cloudRestaurantAccountProvision'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'

async function requireAdmin() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) throw new Error('Unauthorized')
  const user = session.user as any
  if (!['admin', 'owner'].includes(String(user.role))) throw new Error('Admin only')
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

/** GET /api/restaurant/waiters — list branch users */
export async function GET() {
  try {
    const admin = await requireAdmin()
    const adminContext = await getRestaurantContextForUser(admin.id)
    const restaurant = adminContext?.restaurant
    if (!restaurant) return NextResponse.json({ error: 'No restaurant is linked to this account' }, { status: 409 })

    const ownerAccounts = await prisma.user.findMany({
      where: {
        role: 'owner',
        restaurants: { some: { id: restaurant.id } },
      },
      select: { id: true, name: true, email: true, role: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({ ownerAccounts, restaurant })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: e.message === 'Unauthorized' ? 401 : 403 })
  }
}

/** POST /api/restaurant/waiters — create a waiter or owner account */
export async function POST(req: Request) {
  try {
    const admin = await requireAdmin()
    const adminContext = await getRestaurantContextForUser(admin.id)
    const restaurant = adminContext?.restaurant
    if (!restaurant) return NextResponse.json({ error: 'No restaurant is linked to this account' }, { status: 409 })
    if (!adminContext.branchId) {
      return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })
    }

    const ownerCheck = await prisma.restaurant.findFirst({
      where: { id: restaurant.id, ownerId: admin.id },
      select: { id: true },
    })
    if (!ownerCheck) {
      return NextResponse.json({ error: 'You do not own this restaurant' }, { status: 403 })
    }

    const { name, email, password, role: reqRole, syncTargetUrl, syncEmail, syncPassword } = await req.json()
    if (!name?.trim() || !email?.trim() || !password?.trim()) {
      return NextResponse.json({ error: 'name, email, and password are required' }, { status: 400 })
    }
    if (reqRole !== 'owner') {
      return NextResponse.json({ error: 'This endpoint only creates owner (investor) accounts. Use /api/restaurant/employees for waiter accounts.' }, { status: 400 })
    }
    const accountRole = 'owner'
    const normalizedEmail = email.trim().toLowerCase()
    const trimmedName = name.trim()
    let cloudProvisionWarning: string | null = null

    const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } })
    const canUpdateExistingOwner = Boolean(
      existing
      && accountRole === 'owner'
      && existing.role === 'owner'
    )

    if (existing && !canUpdateExistingOwner) {
      return NextResponse.json({ error: 'Email already in use' }, { status: 409 })
    }

    if (canProvisionToCloud()) {
      const remoteProvision = await provisionRestaurantAccountInCloud({
        restaurant: { name: restaurant.name },
        role: accountRole,
        name: trimmedName,
        email: normalizedEmail,
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
            },
            select: { id: true, name: true, email: true, role: true, createdAt: true },
          })
        : await prisma.user.create({
            data: {
              name: trimmedName,
              email: normalizedEmail,
              password: hashed,
              role: accountRole,
            },
            select: { id: true, name: true, email: true, role: true, createdAt: true },
          })
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error
      }

      const existingAfterConflict = await prisma.user.findUnique({
        where: { email: normalizedEmail },
        select: { id: true, role: true },
      })

      if (!existingAfterConflict || existingAfterConflict.role !== accountRole) {
        throw error
      }

      waiter = await prisma.user.update({
        where: { id: existingAfterConflict.id },
        data: {
          name: trimmedName,
          password: hashed,
          role: accountRole,
        },
        select: { id: true, name: true, email: true, role: true, createdAt: true },
      })
      updated = true
    }

    return NextResponse.json({ waiter, updated, cloudProvisionWarning }, { status: updated ? 200 : 201 })
  } catch (e: any) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return NextResponse.json({ error: 'Email already in use' }, { status: 409 })
    }
    const status = e.message === 'Unauthorized' ? 401 : e.message === 'Admin only' ? 403 : 500
    return NextResponse.json({ error: e.message }, { status })
  }
}
