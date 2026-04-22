import type { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import { compare, hash } from 'bcryptjs'
import { randomUUID } from 'crypto'
import type { User } from '@prisma/client'
import { isLocalFirstDesktopAuthBridgeEnabled, verifyCloudCredentials, type RemoteVerifiedRestaurant } from '@/lib/cloudAuthBridge'
import { prisma } from '@/lib/prisma'
import { ensureRestaurantForOwner, findOwnedRestaurant, getRestaurantContextForUser } from '@/lib/restaurantAccess'

function isStaleJwtSessionError(metadata: unknown) {
  const error = (metadata as { error?: { name?: string; message?: string } } | undefined)?.error
  const name = String(error?.name ?? '')
  const message = String(error?.message ?? '').toLowerCase()

  return name === 'JWEDecryptionFailed' || message.includes('decryption operation failed')
}

async function ensureLocalRestaurantOwnerFromCloud(remoteRestaurant: RemoteVerifiedRestaurant, fallbackUser: {
  id: string
  email: string
  name: string | null
  role: string
  businessType: string | null
  trackingMode: string | null
  isActive: boolean
}) {
  const remoteOwner = remoteRestaurant.owner
  if (!remoteOwner) return fallbackUser.id

  const sameUser = remoteOwner.email.trim().toLowerCase() === fallbackUser.email.trim().toLowerCase()
  if (sameUser) return fallbackUser.id

  const existing = await prisma.user.findUnique({ where: { email: remoteOwner.email.trim().toLowerCase() } })
  if (existing) {
    const updated = await prisma.user.update({
      where: { id: existing.id },
      data: {
        name: remoteOwner.name,
        role: remoteOwner.role,
        businessType: remoteOwner.businessType ?? 'restaurant',
        trackingMode: remoteOwner.trackingMode === 'dish_tracking' ? 'dish_tracking' : 'simple',
        isActive: remoteOwner.isActive,
      },
      select: { id: true },
    })
    return updated.id
  }

  const placeholderPassword = await hash(`cloud-owner-stub:${remoteOwner.email}:${randomUUID()}`, 12)
  const created = await prisma.user.create({
    data: {
      name: remoteOwner.name,
      email: remoteOwner.email.trim().toLowerCase(),
      password: placeholderPassword,
      role: remoteOwner.role,
      businessType: remoteOwner.businessType ?? 'restaurant',
      trackingMode: remoteOwner.trackingMode === 'dish_tracking' ? 'dish_tracking' : 'simple',
      isActive: remoteOwner.isActive,
    },
    select: { id: true },
  })
  return created.id
}

async function attachLocalRestaurantFromCloud(user: {
  id: string
  email: string
  name: string | null
  role: string
  businessType: string | null
  trackingMode: string | null
  isActive: boolean
}, remoteRestaurant: RemoteVerifiedRestaurant) {
  const ownerId = await ensureLocalRestaurantOwnerFromCloud(remoteRestaurant, user)
  const existingBySyncId = remoteRestaurant.syncRestaurantId
    ? await prisma.restaurant.findUnique({ where: { syncRestaurantId: remoteRestaurant.syncRestaurantId } })
    : null
  const linkedRestaurant = user.role === 'admin' || user.role === 'owner'
    ? await findOwnedRestaurant(user.id)
    : user.id
      ? await prisma.restaurant.findUnique({ where: { id: (await prisma.user.findUnique({ where: { id: user.id }, select: { restaurantId: true } }))?.restaurantId ?? '' } }).catch(() => null)
      : null

  const restaurant = existingBySyncId
    ? await prisma.restaurant.update({
        where: { id: existingBySyncId.id },
        data: {
          ownerId,
          name: remoteRestaurant.name || existingBySyncId.name,
          joinCode: remoteRestaurant.joinCode || existingBySyncId.joinCode,
          qrOrderingMode: remoteRestaurant.qrOrderingMode === 'view_only'
            ? 'view_only'
            : remoteRestaurant.qrOrderingMode === 'disabled'
              ? 'disabled'
              : 'order',
          licenseActive: remoteRestaurant.licenseActive,
          licenseExpiry: remoteRestaurant.licenseExpiry ? new Date(remoteRestaurant.licenseExpiry) : null,
          syncRestaurantId: remoteRestaurant.syncRestaurantId ?? existingBySyncId.syncRestaurantId,
          syncToken: remoteRestaurant.syncToken ?? existingBySyncId.syncToken,
        },
      })
    : linkedRestaurant
      ? await prisma.restaurant.update({
          where: { id: linkedRestaurant.id },
          data: {
            ownerId,
            name: remoteRestaurant.name || linkedRestaurant.name,
            joinCode: remoteRestaurant.joinCode || linkedRestaurant.joinCode,
            qrOrderingMode: remoteRestaurant.qrOrderingMode === 'view_only'
              ? 'view_only'
              : remoteRestaurant.qrOrderingMode === 'disabled'
                ? 'disabled'
                : 'order',
            licenseActive: remoteRestaurant.licenseActive,
            licenseExpiry: remoteRestaurant.licenseExpiry ? new Date(remoteRestaurant.licenseExpiry) : null,
            syncRestaurantId: remoteRestaurant.syncRestaurantId ?? linkedRestaurant.syncRestaurantId,
            syncToken: remoteRestaurant.syncToken ?? linkedRestaurant.syncToken,
          },
        })
      : await prisma.restaurant.create({
          data: {
            ownerId,
            name: remoteRestaurant.name || 'My Restaurant',
            joinCode: remoteRestaurant.joinCode || `SYNC${randomUUID().slice(0, 6).toUpperCase()}`,
            qrOrderingMode: remoteRestaurant.qrOrderingMode === 'view_only'
              ? 'view_only'
              : remoteRestaurant.qrOrderingMode === 'disabled'
                ? 'disabled'
                : 'order',
            licenseActive: remoteRestaurant.licenseActive,
            licenseExpiry: remoteRestaurant.licenseExpiry ? new Date(remoteRestaurant.licenseExpiry) : null,
            syncRestaurantId: remoteRestaurant.syncRestaurantId,
            syncToken: remoteRestaurant.syncToken,
          },
        })

  await prisma.user.update({
    where: { id: user.id },
    data: { restaurantId: restaurant.id },
  })

  if (ownerId !== user.id) {
    await prisma.user.update({
      where: { id: ownerId },
      data: { restaurantId: restaurant.id },
    }).catch(() => undefined)
  }

  return restaurant
}

async function syncLocalUserFromCloud(email: string, password: string) {
  if (!isLocalFirstDesktopAuthBridgeEnabled()) return null

  const remote = await verifyCloudCredentials(email, password)
  if (remote.ok === false) {
    if (remote.error === 'AccountInactive') {
      throw new Error('AccountInactive')
    }

    return null
  }

  const hashedPassword = await hash(password, 12)
  const syncedUser = await prisma.user.upsert({
    where: { email },
    create: {
      name: remote.user.name,
      email: remote.user.email,
      password: hashedPassword,
      role: remote.user.role,
      businessType: remote.user.businessType ?? 'restaurant',
      trackingMode: remote.user.trackingMode === 'dish_tracking' ? 'dish_tracking' : 'simple',
      isActive: remote.user.isActive,
      isSuperAdmin: remote.user.isSuperAdmin,
      subscriptionPlan: remote.user.subscriptionPlan,
      subscriptionActivatedAt: remote.user.subscriptionActivatedAt ? new Date(remote.user.subscriptionActivatedAt) : null,
      subscriptionExpiry: remote.user.subscriptionExpiry ? new Date(remote.user.subscriptionExpiry) : null,
      restaurantId: null,
    },
    update: {
      name: remote.user.name,
      password: hashedPassword,
      role: remote.user.role,
      businessType: remote.user.businessType ?? 'restaurant',
      trackingMode: remote.user.trackingMode === 'dish_tracking' ? 'dish_tracking' : 'simple',
      isActive: remote.user.isActive,
      isSuperAdmin: remote.user.isSuperAdmin,
      subscriptionPlan: remote.user.subscriptionPlan,
      subscriptionActivatedAt: remote.user.subscriptionActivatedAt ? new Date(remote.user.subscriptionActivatedAt) : null,
      subscriptionExpiry: remote.user.subscriptionExpiry ? new Date(remote.user.subscriptionExpiry) : null,
    },
  })

  if (remote.restaurant) {
    await attachLocalRestaurantFromCloud(syncedUser, remote.restaurant)
  } else if (syncedUser.role === 'admin' || syncedUser.role === 'owner') {
    await ensureRestaurantForOwner(syncedUser.id)
  }

  return prisma.user.findUnique({ where: { email } })
}

async function refreshLocalUserFromCloudAfterPasswordMatch(user: User, email: string, password: string): Promise<User> {
  if (!isLocalFirstDesktopAuthBridgeEnabled()) return user

  try {
    const syncedUser = await syncLocalUserFromCloud(email, password)
    return syncedUser ?? user
  } catch (error) {
    if (error instanceof Error && error.message === 'AccountInactive') {
      throw error
    }

    return user
  }
}

async function buildAuthorizedUser(user: {
  id: string
  email: string
  name: string | null
  role: string
  businessType: string | null
  isActive: boolean
  isSuperAdmin: boolean
  trackingMode?: string | null
  restaurantId?: string | null
  branchId?: string | null
}) {
  const context = await getRestaurantContextForUser(user.id)
  const restaurantId = context?.restaurantId ?? (user as any).restaurantId ?? null
  const branchId = context?.branchId ?? (user as any).branchId ?? null

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    businessType: user.businessType ?? 'general',
    trackingMode: (user as any).trackingMode ?? 'simple',
    restaurantId,
    branchId,
    isActive: user.isActive,
    isSuperAdmin: user.isSuperAdmin,
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' }
      },
      async authorize(credentials) {
        const email = credentials?.email?.trim().toLowerCase()
        const password = credentials?.password
        if (!email || !password) return null

    let user = await prisma.user.findUnique({ where: { email } })
    if (user) {
      const ok = await compare(password, user.password)
      if (ok) {
      user = await refreshLocalUserFromCloudAfterPasswordMatch(user, email, password)
      if (!user.isActive && !user.isSuperAdmin) {
        throw new Error('AccountInactive')
      }

      return buildAuthorizedUser(user)
      }
    }

    const syncedUser = await syncLocalUserFromCloud(email, password)
    if (!syncedUser) return null
    if (!syncedUser.isActive && !syncedUser.isSuperAdmin) {
      throw new Error('AccountInactive')
    }

    return buildAuthorizedUser(syncedUser)
      }
    })
  ],
  session: { strategy: 'jwt' as const },
  pages: { signIn: '/login' },
  logger: {
    error(code, metadata) {
      // Old session cookies become undecryptable after NEXTAUTH_SECRET changes.
      // Treat that state as signed out instead of filling the dev log with noise.
      if (code === 'JWT_SESSION_ERROR' && isStaleJwtSessionError(metadata)) {
        return
      }

      console.error(`[next-auth][error][${code}]`, metadata)
    },
  },
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      if (user) {
		;(token as any).id = (user as any).id
		;(token as any).role = (user as any).role
		;(token as any).businessType = (user as any).businessType ?? 'general'
		;(token as any).trackingMode = (user as any).trackingMode ?? 'simple'
		;(token as any).restaurantId = (user as any).restaurantId ?? null
    ;(token as any).branchId = (user as any).branchId ?? null
		;(token as any).isActive = (user as any).isActive ?? true
		;(token as any).isSuperAdmin = (user as any).isSuperAdmin ?? false
      }

    if (trigger === 'update' && session) {
    if (Object.prototype.hasOwnProperty.call(session, 'restaurantId')) {
      ;(token as any).restaurantId = (session as any).restaurantId ?? null
    }
    if (Object.prototype.hasOwnProperty.call(session, 'branchId')) {
      ;(token as any).branchId = (session as any).branchId ?? null
    }
    }
      return token
    },
    async session({ session, token }) {
      if (session.user) {
		;(session.user as any).id = (token as any).id
		;(session.user as any).role = (token as any).role
		;(session.user as any).businessType = (token as any).businessType ?? 'general'
		;(session.user as any).trackingMode = (token as any).trackingMode ?? 'simple'
		;(session.user as any).restaurantId = (token as any).restaurantId ?? null
    ;(session.user as any).branchId = (token as any).branchId ?? null
		;(session.user as any).isActive = (token as any).isActive ?? true
		;(session.user as any).isSuperAdmin = (token as any).isSuperAdmin ?? false
      }
      return session
    }
  }
}
