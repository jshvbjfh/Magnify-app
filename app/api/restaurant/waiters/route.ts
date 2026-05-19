import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { Prisma } from '@prisma/client'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { hash } from 'bcryptjs'
import { provisionRestaurantAccountInCloud } from '@/lib/cloudRestaurantAccountProvision'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { enqueueSyncChange } from '@/lib/syncOutbox'

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

/** GET /api/restaurant/waiters — list waiter staff accounts and owner accounts */
export async function GET() {
  try {
    const admin = await requireAdmin()
    const adminContext = await getRestaurantContextForUser(admin.id)
    const restaurant = adminContext?.restaurant
    if (!restaurant) return NextResponse.json({ error: 'No restaurant is linked to this account' }, { status: 409 })

    const [waiterStaff, ownerAccounts] = await Promise.all([
      prisma.staff.findMany({
        where: { restaurantId: restaurant.id, role: 'waiter', deletedAt: null },
        select: { id: true, name: true, username: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.user.findMany({
        where: { role: 'owner', restaurants: { some: { id: restaurant.id } } },
        select: { id: true, name: true, email: true, role: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
    ])

    // Map Staff.username → email so the UI Waiter type is satisfied
    const waiters = waiterStaff.map(s => ({
      id: s.id,
      name: s.name,
      email: s.username ?? '',
      createdAt: s.createdAt,
    }))

    return NextResponse.json({ waiters, ownerAccounts, restaurant })
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: e.message === 'Unauthorized' ? 401 : 403 })
  }
}

/** POST /api/restaurant/waiters
 *  role='owner'  → creates a User (investor) and links them to the restaurant
 *  role omitted  → creates a Staff record (waiter) scoped to restaurantId + branchId
 */
export async function POST(req: Request) {
  try {
    const admin = await requireAdmin()
    const adminContext = await getRestaurantContextForUser(admin.id)
    const restaurant = adminContext?.restaurant
    if (!restaurant) return NextResponse.json({ error: 'No restaurant is linked to this account' }, { status: 409 })
    if (!adminContext.branchId) {
      return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })
    }

    const { name, email, password, role: reqRole, syncTargetUrl, syncEmail, syncPassword } = await req.json()
    if (!name?.trim() || !email?.trim() || !password?.trim()) {
      return NextResponse.json({ error: 'name, email, and password are required' }, { status: 400 })
    }

    const normalizedEmail = email.trim().toLowerCase()
    const trimmedName = name.trim()
    let cloudProvisionWarning: string | null = null

    // ── Owner (User) account path ──────────────────────────────────────────
    if (reqRole === 'owner') {
      const ownerCheck = await prisma.restaurant.findFirst({
        where: { id: restaurant.id, ownerId: admin.id },
        select: { id: true },
      })
      if (!ownerCheck) {
        return NextResponse.json({ error: 'You do not own this restaurant' }, { status: 403 })
      }

      const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } })
      const canUpdateExistingOwner = Boolean(existing && existing.role === 'owner')

      if (existing && !canUpdateExistingOwner) {
        return NextResponse.json({ error: 'Email already in use' }, { status: 409 })
      }

      if (canProvisionToCloud()) {
        const remoteProvision = await provisionRestaurantAccountInCloud({
          restaurant: { name: restaurant.name },
          role: 'owner',
          name: trimmedName,
          email: normalizedEmail,
          password,
          branchId: adminContext.branchId,
          syncTargetUrl,
          syncEmail,
          syncPassword,
          adminEmail: admin.email,
        })
        if (!remoteProvision.ok) cloudProvisionWarning = remoteProvision.error
      }

      const hashed = await hash(password, 12)
      let updated = canUpdateExistingOwner
      let ownerUser

      try {
        ownerUser = canUpdateExistingOwner
          ? await prisma.user.update({
              where: { id: existing!.id },
              data: { name: trimmedName, password: hashed, role: 'owner' },
              select: { id: true, name: true, email: true, role: true, createdAt: true },
            })
          : await prisma.user.create({
              data: { name: trimmedName, email: normalizedEmail, password: hashed, role: 'owner' },
              select: { id: true, name: true, email: true, role: true, createdAt: true },
            })
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') throw error
        const existingAfterConflict = await prisma.user.findUnique({
          where: { email: normalizedEmail },
          select: { id: true, role: true },
        })
        if (!existingAfterConflict || existingAfterConflict.role !== 'owner') throw error
        ownerUser = await prisma.user.update({
          where: { id: existingAfterConflict.id },
          data: { name: trimmedName, password: hashed, role: 'owner' },
          select: { id: true, name: true, email: true, role: true, createdAt: true },
        })
        updated = true
      }

      // Link this owner to the restaurant so the GET query can find them
      await prisma.restaurant.update({
        where: { id: restaurant.id },
        data: { ownerId: ownerUser.id },
      })

      return NextResponse.json({ waiter: ownerUser, updated, cloudProvisionWarning }, { status: updated ? 200 : 201 })
    }

    // ── Waiter (Staff) account path ────────────────────────────────────────
    const existingStaff = await prisma.staff.findFirst({
      where: { restaurantId: restaurant.id, username: normalizedEmail },
    })
    if (existingStaff) {
      return NextResponse.json({ error: 'Email already in use' }, { status: 409 })
    }

    if (canProvisionToCloud()) {
      const remoteProvision = await provisionRestaurantAccountInCloud({
        restaurant: { name: restaurant.name },
        role: 'waiter',
        name: trimmedName,
        email: normalizedEmail,
        password,
        branchId: adminContext.branchId,
        syncTargetUrl,
        syncEmail,
        syncPassword,
        adminEmail: admin.email,
      })
      if (!remoteProvision.ok) cloudProvisionWarning = remoteProvision.error
    }

    const hashed = await hash(password, 12)
    const waiterStaff = await prisma.staff.create({
      data: {
        restaurantId: restaurant.id,
        name: trimmedName,
        username: normalizedEmail,
        password: hashed,
        role: 'waiter',
        branches: {
          create: { branchId: adminContext.branchId },
        },
      },
      select: { id: true, name: true, username: true, role: true, createdAt: true },
    })

    await enqueueSyncChange(prisma, {
      restaurantId: restaurant.id,
      branchId: adminContext.branchId,
      entityType: 'staff',
      entityId: waiterStaff.id,
      operation: 'upsert',
      payload: waiterStaff,
    })

    const waiter = {
      id: waiterStaff.id,
      name: waiterStaff.name,
      email: waiterStaff.username,
      role: waiterStaff.role,
      createdAt: waiterStaff.createdAt,
    }
    return NextResponse.json({ waiter, updated: false, cloudProvisionWarning }, { status: 201 })
  } catch (e: any) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      return NextResponse.json({ error: 'Email already in use' }, { status: 409 })
    }
    const status = e.message === 'Unauthorized' ? 401 : e.message === 'Admin only' ? 403 : 500
    return NextResponse.json({ error: e.message }, { status })
  }
}
