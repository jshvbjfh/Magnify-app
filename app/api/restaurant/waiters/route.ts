import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { Prisma } from '@prisma/client'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { hash } from 'bcryptjs'
import { provisionRestaurantAccountInCloud, resolveCloudRestaurantIdentity } from '@/lib/cloudRestaurantAccountProvision'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { ensureRestaurantStaffLoginUser } from '@/lib/restaurantStaffUsers'
import { cached } from '@/lib/apiCache'
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
  // Only needed for local-first Electron: the local SQLite DB must replicate accounts to
  // the remote cloud server. On Vercel/PostgreSQL, accounts land directly in the cloud DB
  // at creation time — no separate provisioning step is needed or possible.
  return isLocalFirstDesktopMode()
}

async function ensureProvisioningRestaurantIdentity(params: {
  restaurant: { id: string; name: string; joinCode?: string | null; syncRestaurantId?: string | null }
  syncTargetUrl?: string | null
  syncEmail?: string | null
  syncPassword?: string | null
  adminEmail?: string | null
}) {
  const currentSyncRestaurantId = String(params.restaurant.syncRestaurantId ?? '').trim()
  if (currentSyncRestaurantId) return params.restaurant

  const resolved = await resolveCloudRestaurantIdentity({
    restaurant: {
      name: params.restaurant.name,
      joinCode: params.restaurant.joinCode,
      syncRestaurantId: params.restaurant.syncRestaurantId,
    },
    syncTargetUrl: params.syncTargetUrl,
    syncEmail: params.syncEmail,
    syncPassword: params.syncPassword,
    adminEmail: params.adminEmail,
  })

  if (!resolved.ok) {
    throw new Error(`Cloud restaurant identity could not be verified for this desktop. ${resolved.error}`)
  }

  const nextJoinCode = resolved.restaurant.joinCode
  const nextSyncRestaurantId = resolved.restaurant.syncRestaurantId
  if (
    nextJoinCode === (params.restaurant.joinCode ?? null)
    && nextSyncRestaurantId === (params.restaurant.syncRestaurantId ?? null)
  ) {
    return params.restaurant
  }

  return prisma.restaurant.update({
    where: { id: params.restaurant.id },
    data: {
      ...(nextJoinCode ? { joinCode: nextJoinCode } : {}),
      ...(nextSyncRestaurantId ? { syncRestaurantId: nextSyncRestaurantId } : {}),
    },
  })
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

    return cached({ waiters, ownerAccounts, restaurant })
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
    const branchId = adminContext.branchId

    const { name, email, password, role: reqRole, syncTargetUrl, syncEmail, syncPassword } = await req.json()
    if (!name?.trim() || !email?.trim() || !password?.trim()) {
      return NextResponse.json({ error: 'name, email, and password are required' }, { status: 400 })
    }

    const provisioningRestaurant = canProvisionToCloud()
      ? await ensureProvisioningRestaurantIdentity({
          restaurant,
          syncTargetUrl,
          syncEmail,
          syncPassword,
          adminEmail: admin.email,
        })
      : restaurant

    const normalizedEmail = email.trim().toLowerCase()
    const trimmedName = name.trim()
    let cloudProvisionWarning: string | null = null

    // ── Owner (User) account path ──────────────────────────────────────────
    if (reqRole === 'owner') {
      // Access is already verified: requireAdmin() confirmed admin/owner role,
      // and getRestaurantContextForUser confirmed this user is linked to the restaurant
      // (either as ownerId or managerId). No additional gate needed.

      const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } })
      const canUpdateExistingOwner = Boolean(existing && existing.role === 'owner')

      if (existing && !canUpdateExistingOwner) {
        return NextResponse.json({ error: 'Email already in use' }, { status: 409 })
      }

      if (canProvisionToCloud()) {
        const remoteProvision = await provisionRestaurantAccountInCloud({
          restaurant: {
            name: provisioningRestaurant.name,
            joinCode: (provisioningRestaurant as any).joinCode,
            syncRestaurantId: (provisioningRestaurant as any).syncRestaurantId,
          },
          role: 'owner',
          name: trimmedName,
          email: normalizedEmail,
          password,
          branchId,
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

    const existingLoginUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true },
    })
    if (existingLoginUser) {
      return NextResponse.json({ error: 'Email already in use' }, { status: 409 })
    }

    const hashed = await hash(password, 12)
    const waiterStaff = await prisma.$transaction(async (tx) => {
      const createdStaff = await tx.staff.create({
        data: {
          restaurantId: restaurant.id,
          name: trimmedName,
          username: normalizedEmail,
          password: hashed,
          role: 'waiter',
          branches: {
            create: { branchId },
          },
        },
        select: { id: true, name: true, username: true, role: true, isActive: true, createdAt: true, updatedAt: true },
      })

      await ensureRestaurantStaffLoginUser(tx, {
        id: createdStaff.id,
        email: normalizedEmail,
        name: trimmedName,
        passwordHash: hashed,
        role: 'waiter',
        isActive: createdStaff.isActive,
      })

      return createdStaff
    })

    const syncPayload = {
      id: waiterStaff.id,
      restaurantId: restaurant.id,
      branchId: adminContext.branchId,
      name: waiterStaff.name,
      username: waiterStaff.username,
      password: hashed,
      role: waiterStaff.role,
      isActive: waiterStaff.isActive,
      createdAt: waiterStaff.createdAt,
      updatedAt: waiterStaff.updatedAt,
    }

    await enqueueSyncChange(prisma, {
      restaurantId: restaurant.id,
      branchId: adminContext.branchId,
      entityType: 'staff',
      entityId: waiterStaff.id,
      operation: 'upsert',
      payload: syncPayload,
    })

    // Immediately provision to cloud using the actual staff ID so the waiter
    // can log in to the mobile app without waiting for background sync.
    if (canProvisionToCloud()) {
      const remoteProvision = await provisionRestaurantAccountInCloud({
        restaurant: {
          name: provisioningRestaurant.name,
          joinCode: (provisioningRestaurant as any).joinCode,
          syncRestaurantId: (provisioningRestaurant as any).syncRestaurantId,
        },
        role: 'waiter',
        name: trimmedName,
        email: normalizedEmail,
        password,
        staffId: waiterStaff.id,
        branchId,
        syncTargetUrl,
        syncEmail,
        syncPassword,
        adminEmail: admin.email,
      })
      if (!remoteProvision.ok) cloudProvisionWarning = remoteProvision.error
    }

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
