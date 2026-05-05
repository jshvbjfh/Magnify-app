import { compare, hash } from 'bcryptjs'
import { timingSafeEqual } from 'crypto'
import { Prisma } from '@prisma/client'
import { NextResponse } from 'next/server'

import { prisma } from '@/lib/prisma'
import { ensureMainBranchForRestaurant, resolveRestaurantForSyncUser } from '@/lib/restaurantAccess'

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function matchesSharedSecret(input: string, expected: string) {
  if (!input || !expected) return false
  const a = Buffer.from(input)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

async function authenticateSyncUser(request: Request) {
  const email = request.headers.get('x-sync-email')?.trim().toLowerCase() ?? ''
  const sharedSecret = request.headers.get('x-sync-secret')?.trim() ?? ''
  const password = request.headers.get('x-sync-password') ?? ''

  if (!sharedSecret && (!email || !password)) {
    return { error: NextResponse.json({ error: 'Sync credentials are required' }, { status: 401 }) }
  }

  const configuredSharedSecret = process.env.OWNER_SYNC_SHARED_SECRET?.trim() ?? ''
  if (sharedSecret) {
    if (!matchesSharedSecret(sharedSecret, configuredSharedSecret)) {
      return { error: NextResponse.json({ error: 'Invalid sync credentials' }, { status: 401 }) }
    }
    const user = email ? await prisma.user.findUnique({ where: { email } }) : null
    return { user, authMode: 'shared-secret' as const }
  }

  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) {
    return { error: NextResponse.json({ error: 'Invalid sync credentials' }, { status: 401 }) }
  } else {
    const passwordOk = await compare(password, user.password)
    if (!passwordOk) {
      return { error: NextResponse.json({ error: 'Invalid sync credentials' }, { status: 401 }) }
    }
  }

  return { user, authMode: 'password' as const }
}

async function resolveProvisioningRestaurant(params: {
  authUser: {
    id: string
    role: string
    restaurantId: string | null
  } | null
  restaurantSyncId: string
  restaurantToken: string
  restaurantName: string
}) {
  const existingRestaurant = await prisma.restaurant.findUnique({
    where: { syncRestaurantId: params.restaurantSyncId },
    select: { id: true, name: true, syncToken: true },
  })

  // Shared-secret provisioning should bind to the restaurant identity proved by
  // the sync id + token, not to whichever user email happens to be configured on
  // the desktop build. This keeps account provisioning isolated from owner-sync.
  if (existingRestaurant) {
    if (existingRestaurant.syncToken !== params.restaurantToken) {
      return {
        ok: false as const,
        status: 401,
        error: 'Invalid restaurant sync token',
      }
    }

    return {
      ok: true as const,
      restaurant: existingRestaurant,
    }
  }

  if (!params.authUser) {
    return {
      ok: false as const,
      status: 409,
      error: 'This branch is not linked in Magnify cloud yet. Run branch sync first, then try again.',
    }
  }

  return resolveRestaurantForSyncUser({
    id: params.authUser.id,
    role: params.authUser.role,
    restaurantId: params.authUser.restaurantId,
  }, {
    restaurantSyncId: params.restaurantSyncId,
    restaurantToken: params.restaurantToken,
    restaurantName: params.restaurantName,
  })
}
export async function POST(request: Request) {
  try {
    const auth = await authenticateSyncUser(request)
    if ('error' in auth) return auth.error

    const body = await request.json().catch(() => null)
    const restaurantSyncId = String(body?.restaurantSyncId ?? '').trim()
    const restaurantToken = String(body?.restaurantToken ?? '')
    const restaurantName = String(body?.restaurantName ?? '').trim()
    const requestedRole = body?.role === 'waiter' ? 'waiter' : body?.role === 'kitchen' ? 'kitchen' : 'owner'
    const requestedBranchId = String(body?.branchId ?? '').trim() || null
    const accountName = String(body?.name ?? '').trim()
    const accountEmail = String(body?.email ?? '').trim().toLowerCase()
    const accountPassword = String(body?.password ?? '')

    if (!restaurantSyncId || !restaurantToken || !accountName || !accountEmail || !accountPassword) {
      return NextResponse.json(
        { error: 'restaurantSyncId, restaurantToken, name, email, and password are required' },
        { status: 400 }
      )
    }

    if (!EMAIL_REGEX.test(accountEmail)) {
      return NextResponse.json({ error: 'Please enter a valid email address' }, { status: 400 })
    }

    if (accountName.length < 2 || accountName.length > 120) {
      return NextResponse.json({ error: 'Name must be between 2 and 120 characters long' }, { status: 400 })
    }

    if (accountPassword.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters long' }, { status: 400 })
    }

    if (accountPassword.length > 128) {
      return NextResponse.json({ error: 'Password is too long' }, { status: 400 })
    }

    const restaurantAccess = auth.authMode === 'shared-secret'
      ? await resolveProvisioningRestaurant({
          authUser: auth.user
            ? {
                id: auth.user.id,
                role: auth.user.role,
                restaurantId: auth.user.restaurantId ?? null,
              }
            : null,
          restaurantSyncId,
          restaurantToken,
          restaurantName,
        })
      : await resolveRestaurantForSyncUser({
          id: auth.user.id,
          role: auth.user.role,
          restaurantId: auth.user.restaurantId ?? null,
        }, {
          restaurantSyncId,
          restaurantToken,
          restaurantName,
        })
    if (!restaurantAccess.ok) {
      const failed = restaurantAccess as { ok: false; status: number; error: string; linkedRestaurant?: { id: string; name: string; syncRestaurantId: string; syncToken: string } }
      return NextResponse.json({
        error: failed.error,
        ...(failed.linkedRestaurant ? { linkedRestaurant: failed.linkedRestaurant } : {}),
      }, { status: failed.status })
    }

    const restaurant = restaurantAccess.restaurant
  const mainBranch = await ensureMainBranchForRestaurant(restaurant.id)

  // Resolve which branch to assign this account to. Use the requested branchId
  // if it's a real active branch in this restaurant; otherwise fall back to main.
  let resolvedBranchId = mainBranch?.id ?? null
  if (requestedBranchId) {
    const requestedBranch = await prisma.restaurantBranch.findFirst({
      where: { id: requestedBranchId, restaurantId: restaurant.id, isActive: true },
      select: { id: true },
    })
    if (requestedBranch) resolvedBranchId = requestedBranch.id
  }
    const existingAccount = await prisma.user.findUnique({ where: { email: accountEmail } })
    if (existingAccount && !['owner', 'waiter', 'kitchen'].includes(existingAccount.role)) {
      return NextResponse.json({ error: 'This email is already used by another account type' }, { status: 409 })
    }

    if (existingAccount && existingAccount.role !== requestedRole) {
      return NextResponse.json({ error: 'This email is already linked to a different restaurant role' }, { status: 409 })
    }

    if (existingAccount?.restaurantId && existingAccount.restaurantId !== restaurant.id) {
      return NextResponse.json({ error: 'This account email is already linked to a different restaurant' }, { status: 409 })
    }

    if (requestedRole === 'owner' && existingAccount) {
      const ownedRestaurant = await prisma.restaurant.findFirst({
        where: { ownerId: existingAccount.id },
        select: { id: true },
      })

      if (ownedRestaurant && ownedRestaurant.id !== restaurant.id) {
        return NextResponse.json({ error: 'This owner email is already linked to a different restaurant' }, { status: 409 })
      }
    }

    // For owner-role provisioning, verify the resolved restaurant is actually owned
    // by the requesting admin (not just linked via restaurantId). This prevents an
    // admin drifted onto a stale/wrong restaurant from provisioning owner accounts
    // into a restaurant they don't own.
    if (requestedRole === 'owner') {
      if (auth.user) {
        // Password-auth path: the requesting user must be either an admin role
        // (site-wide admin, authorized by holding the correct syncToken) or the
        // direct DB-level owner of this restaurant. This lets a desktop configured
        // with an admin OWNER_SYNC_EMAIL provision owner accounts even when that
        // admin is not the ownerId row on the restaurant record.
        const adminOwnsRestaurant = await prisma.restaurant.findFirst({
          where: { id: restaurant.id, ownerId: auth.user.id },
          select: { id: true },
        })
        const userIsAdmin = auth.user.role === 'admin'
        if (!adminOwnsRestaurant && !userIsAdmin) {
          return NextResponse.json(
            { error: 'You can only provision owner accounts for a restaurant you own' },
            { status: 403 }
          )
        }
      } else {
        // Shared-secret path: no user identity, but the restaurant's ownerId must
        // resolve to a real active admin account so we don't provision into orphans.
        const restaurantOwner = await prisma.user.findFirst({
          where: { id: (await prisma.restaurant.findUnique({ where: { id: restaurant.id }, select: { ownerId: true } }))?.ownerId ?? '', isActive: true },
          select: { id: true },
        })
        if (!restaurantOwner) {
          return NextResponse.json(
            { error: 'Cannot provision owner account: restaurant has no active owner' },
            { status: 403 }
          )
        }
      }
    }

    const hashedPassword = await hash(accountPassword, 12)
    let updated = Boolean(existingAccount)
    let account

    try {
      account = existingAccount
        ? await prisma.user.update({
            where: { id: existingAccount.id },
            data: {
              name: accountName,
              password: hashedPassword,
              role: requestedRole,
              businessType: 'restaurant',
              trackingMode: existingAccount.trackingMode ?? 'simple',
              restaurantId: restaurant.id,
              branchId: resolvedBranchId,
              isActive: true,
            },
            select: { id: true, name: true, email: true, role: true, restaurantId: true },
          })
        : await prisma.user.create({
            data: {
              name: accountName,
              email: accountEmail,
              password: hashedPassword,
              role: requestedRole,
              businessType: 'restaurant',
              trackingMode: 'simple',
              restaurantId: restaurant.id,
              branchId: resolvedBranchId,
              isActive: true,
            },
            select: { id: true, name: true, email: true, role: true, restaurantId: true },
          })
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error
      }

      const existingAfterConflict = await prisma.user.findUnique({
        where: { email: accountEmail },
        select: { id: true, role: true, restaurantId: true, branchId: true, trackingMode: true },
      })

      if (!existingAfterConflict || existingAfterConflict.role !== requestedRole || existingAfterConflict.restaurantId !== restaurant.id) {
        throw error
      }

      account = await prisma.user.update({
        where: { id: existingAfterConflict.id },
        data: {
          name: accountName,
          password: hashedPassword,
          role: requestedRole,
          businessType: 'restaurant',
          trackingMode: existingAfterConflict.trackingMode ?? 'simple',
          restaurantId: restaurant.id,
          branchId: resolvedBranchId,
          isActive: true,
        },
        select: { id: true, name: true, email: true, role: true, restaurantId: true },
      })
      updated = true
    }

    return NextResponse.json({
      ok: true,
      account,
      restaurant: { id: restaurant.id, name: restaurant.name },
      updated,
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return NextResponse.json({ error: 'This email is already linked to another account' }, { status: 409 })
    }
    console.error('Restaurant account sync provisioning failed:', error)
    return NextResponse.json({ error: 'Could not provision this restaurant account in Magnify cloud.' }, { status: 500 })
  }
}