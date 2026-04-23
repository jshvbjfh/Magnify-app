import type { Prisma, PrismaClient } from '@prisma/client'

import { prisma } from '@/lib/prisma'
import { randomBytes } from 'crypto'

type PrismaDb = PrismaClient | Prisma.TransactionClient

function makeJoinCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}

async function uniqueJoinCode() {
  let code = makeJoinCode()
  while (await prisma.restaurant.findUnique({ where: { joinCode: code } })) {
    code = makeJoinCode()
  }
  return code
}

function makeSyncRestaurantId() {
  return `branch_${randomBytes(10).toString('hex')}`
}

function makeSyncToken() {
  return randomBytes(24).toString('hex')
}

const DEFAULT_BRANCH_NAME = 'Main'
const DEFAULT_BRANCH_CODE = 'MAIN'

export function normalizeBranchCode(value?: string | null) {
  const normalized = String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '')
  return normalized.slice(0, 12)
}

function normalizeBranchName(value?: string | null) {
  return String(value ?? '').trim().replace(/\s+/g, ' ')
}

async function uniqueBranchCode(db: PrismaDb, restaurantId: string, seed?: string | null) {
  const baseCode = normalizeBranchCode(seed) || DEFAULT_BRANCH_CODE
  let code = baseCode
  let suffix = 2

  while (await db.restaurantBranch.findFirst({ where: { restaurantId, code } })) {
    const suffixText = String(suffix)
    const codeHead = baseCode.slice(0, Math.max(1, 12 - suffixText.length))
    code = `${codeHead}${suffixText}`
    suffix += 1
  }

  return code
}

export function getDefaultRestaurantName(ownerName?: string | null) {
  const normalizedOwnerName = String(ownerName ?? '').trim()
  return normalizedOwnerName || 'My Restaurant'
}

export function normalizeLegacyAutoRestaurantName(restaurantName?: string | null, ownerName?: string | null) {
  const normalizedRestaurantName = String(restaurantName ?? '').trim()
  const normalizedOwnerName = String(ownerName ?? '').trim()

  if (!normalizedRestaurantName) {
    return getDefaultRestaurantName(normalizedOwnerName)
  }

  if (!normalizedOwnerName) {
    return normalizedRestaurantName
  }

  return normalizedRestaurantName === `${normalizedOwnerName}'s Restaurant`
    ? normalizedOwnerName
    : normalizedRestaurantName
}

async function syncUserBranchLink(db: PrismaDb, userId: string, branchId: string) {
  await db.user.update({
    where: { id: userId },
    data: { branchId },
  })
}

export async function ensureMainBranchForRestaurant(restaurantId: string, db: PrismaDb = prisma) {
  const existingMain = await db.restaurantBranch.findFirst({
    where: { restaurantId, isMain: true },
    orderBy: { createdAt: 'asc' },
  })
  if (existingMain) return existingMain

  const existingDefaultCode = await db.restaurantBranch.findFirst({
    where: { restaurantId, code: DEFAULT_BRANCH_CODE },
    orderBy: { createdAt: 'asc' },
  })
  if (existingDefaultCode) {
    return db.restaurantBranch.update({
      where: { id: existingDefaultCode.id },
      data: {
        isMain: true,
        isActive: true,
        sortOrder: 0,
      },
    })
  }

  const restaurant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { id: true },
  })
  if (!restaurant) return null

  return db.restaurantBranch.create({
    data: {
      restaurantId,
      name: DEFAULT_BRANCH_NAME,
      code: await uniqueBranchCode(db, restaurantId, DEFAULT_BRANCH_CODE),
      isMain: true,
      isActive: true,
      sortOrder: 0,
    },
  })
}

export async function isMainRestaurantBranch(restaurantId: string, branchId: string, db: PrismaDb = prisma) {
  const branch = await db.restaurantBranch.findFirst({
    where: { id: branchId, restaurantId },
    select: { isMain: true },
  })

  return Boolean(branch?.isMain)
}

export async function createRestaurantBranch(
  params: {
    restaurantId: string
    name: string
    code?: string | null
    activateUserId?: string | null
  },
  db: PrismaDb = prisma,
) {
  const restaurantId = String(params.restaurantId ?? '').trim()
  const name = normalizeBranchName(params.name)

  if (!restaurantId) throw new Error('Restaurant is required')
  if (!name) throw new Error('Branch name is required')

  await ensureMainBranchForRestaurant(restaurantId, db)

  const existingBranches = await db.restaurantBranch.findMany({
    where: { restaurantId },
    select: { name: true },
  })

  if (existingBranches.some((branch) => normalizeBranchName(branch.name).toLowerCase() === name.toLowerCase())) {
    throw new Error('A branch with this name already exists')
  }

  const lastBranch = await db.restaurantBranch.findFirst({
    where: { restaurantId },
    orderBy: [
      { sortOrder: 'desc' },
      { createdAt: 'desc' },
    ],
    select: { sortOrder: true },
  })

  const branch = await db.restaurantBranch.create({
    data: {
      restaurantId,
      name,
      code: await uniqueBranchCode(db, restaurantId, params.code || name),
      isMain: false,
      isActive: true,
      sortOrder: (lastBranch?.sortOrder ?? 0) + 1,
    },
  })

  if (params.activateUserId) {
    await syncUserBranchLink(db, params.activateUserId, branch.id)
  }

  return branch
}

async function ensureSyncIdentity(restaurantId: string) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      id: true,
      name: true,
      qrOrderingMode: true,
      fifoEnabled: true,
      fifoConfiguredAt: true,
      fifoCutoverAt: true,
      licenseActive: true,
      licenseExpiry: true,
      syncRestaurantId: true,
      syncToken: true,
    },
  })

  if (!restaurant) return null
  if (restaurant.syncRestaurantId && restaurant.syncToken) return restaurant

  let syncRestaurantId = restaurant.syncRestaurantId
  while (!syncRestaurantId || await prisma.restaurant.findFirst({ where: { syncRestaurantId } })) {
    syncRestaurantId = makeSyncRestaurantId()
  }

  const syncToken = restaurant.syncToken || makeSyncToken()

  return prisma.restaurant.update({
    where: { id: restaurant.id },
    data: {
      syncRestaurantId,
      syncToken,
    },
    select: {
      id: true,
      name: true,
      qrOrderingMode: true,
      fifoEnabled: true,
      fifoConfiguredAt: true,
      fifoCutoverAt: true,
      licenseActive: true,
      licenseExpiry: true,
      syncRestaurantId: true,
      syncToken: true,
    },
  })
}

export async function findOwnedRestaurant(ownerId: string) {
  const linkedUser = await prisma.user.findUnique({
    where: { id: ownerId },
    select: { restaurantId: true },
  })

  if (linkedUser?.restaurantId) {
    const linkedRestaurant = await prisma.restaurant.findUnique({ where: { id: linkedUser.restaurantId } })
    if (linkedRestaurant?.ownerId === ownerId) return linkedRestaurant
  }

  return prisma.restaurant.findFirst({ where: { ownerId }, orderBy: { createdAt: 'asc' } })
}

async function syncOwnerRestaurantLink(db: PrismaDb, ownerId: string, restaurantId: string) {
  await db.user.update({
    where: { id: ownerId },
    data: { restaurantId },
  })
}

function toLinkedRestaurantPayload(restaurant: {
  id: string
  name: string
  syncRestaurantId: string | null
  syncToken: string | null
}) {
  return {
    id: restaurant.id,
    name: restaurant.name,
    syncRestaurantId: restaurant.syncRestaurantId,
    syncToken: restaurant.syncToken,
  }
}

export async function resolveRestaurantForSyncUser(user: {
  id: string
  role: string
  restaurantId: string | null
  branchId?: string | null
}, params: {
  restaurantSyncId: string
  restaurantToken: string
  restaurantName?: string | null
}) {
  const existingRestaurant = await prisma.restaurant.findUnique({
    where: { syncRestaurantId: params.restaurantSyncId },
  })

  if (existingRestaurant) {
    const isOwner = existingRestaurant.ownerId === user.id
    const isLinkedStaff = Boolean(user.restaurantId && user.restaurantId === existingRestaurant.id)

    if (!isOwner && !isLinkedStaff) {
      return {
        ok: false as const,
        status: 403,
        error: 'This branch is linked to a different owner account',
      }
    }

    if (existingRestaurant.syncToken !== params.restaurantToken) {
      return {
        ok: false as const,
        status: 401,
        error: 'Invalid restaurant sync token',
      }
    }

    if (isOwner && user.restaurantId !== existingRestaurant.id) {
      await syncOwnerRestaurantLink(prisma, user.id, existingRestaurant.id)
    }

    return {
      ok: true as const,
      restaurant: existingRestaurant,
    }
  }

  if (user.role !== 'admin' && user.role !== 'owner') {
    return {
      ok: false as const,
      status: 403,
      error: 'This branch is not linked to your account',
    }
  }

  const ownedRestaurant = await findOwnedRestaurant(user.id)
  if (ownedRestaurant) {
    if (ownedRestaurant.syncRestaurantId && ownedRestaurant.syncRestaurantId !== params.restaurantSyncId) {
      return {
        ok: false as const,
        status: 409,
        error: 'This owner account is already linked to a different branch identity',
        linkedRestaurant: toLinkedRestaurantPayload(ownedRestaurant),
      }
    }

    const updatedRestaurant = await prisma.restaurant.update({
      where: { id: ownedRestaurant.id },
      data: {
        name: params.restaurantName || ownedRestaurant.name,
        syncRestaurantId: params.restaurantSyncId,
        syncToken: params.restaurantToken,
      },
    })

    if (user.restaurantId !== updatedRestaurant.id) {
      await syncOwnerRestaurantLink(prisma, user.id, updatedRestaurant.id)
    }

    return {
      ok: true as const,
      restaurant: updatedRestaurant,
    }
  }

  const joinCode = await uniqueJoinCode()
  const createdRestaurant = await prisma.restaurant.create({
    data: {
      name: params.restaurantName || 'Synced Branch',
      ownerId: user.id,
      joinCode,
      syncRestaurantId: params.restaurantSyncId,
      syncToken: params.restaurantToken,
    },
  })

  await syncOwnerRestaurantLink(prisma, user.id, createdRestaurant.id)

  return {
    ok: true as const,
    restaurant: createdRestaurant,
  }
}

async function resolveRestaurantForUser(user: { id: string; role: string; restaurantId: string | null }) {
  if (user.role === 'admin' || user.role === 'owner') {
    const ownedRestaurant = await findOwnedRestaurant(user.id)
    if (ownedRestaurant) {
      if (user.restaurantId !== ownedRestaurant.id) {
        await syncOwnerRestaurantLink(prisma, user.id, ownedRestaurant.id)
      }
      return ownedRestaurant
    }
  }

  if (!user.restaurantId) return null
  return prisma.restaurant.findUnique({ where: { id: user.restaurantId } })
}

async function resolveBranchForUser(user: { id: string; role: string; restaurantId: string | null; branchId: string | null }, restaurantId: string) {
  if (user.branchId) {
    const linkedBranch = await prisma.restaurantBranch.findFirst({
      where: {
        id: user.branchId,
        restaurantId,
        isActive: true,
      },
    })
    if (linkedBranch) {
      return linkedBranch
    }
  }

  const mainBranch = await ensureMainBranchForRestaurant(restaurantId)
  if (mainBranch && user.branchId !== mainBranch.id) {
    await syncUserBranchLink(prisma, user.id, mainBranch.id)
  }

  return mainBranch
}

export async function ensureRestaurantForOwner(ownerId: string) {
  const existing = await findOwnedRestaurant(ownerId)
  if (existing) {
    const restaurant = await ensureSyncIdentity(existing.id)
    if (restaurant) {
      await syncOwnerRestaurantLink(prisma, ownerId, restaurant.id)
      const mainBranch = await ensureMainBranchForRestaurant(restaurant.id)
      if (mainBranch) {
        await syncUserBranchLink(prisma, ownerId, mainBranch.id)
      }
    }
    return restaurant
  }

  const user = await prisma.user.findUnique({ where: { id: ownerId }, select: { name: true } })
  const joinCode = await uniqueJoinCode()
  const strictFifoActivatedAt = new Date()

  const created = await prisma.restaurant.create({
    data: {
      name: getDefaultRestaurantName(user?.name),
      ownerId,
      joinCode,
      fifoEnabled: true,
      fifoConfiguredAt: strictFifoActivatedAt,
      fifoCutoverAt: strictFifoActivatedAt,
      syncRestaurantId: makeSyncRestaurantId(),
      syncToken: makeSyncToken(),
    },
  })

  const restaurant = await ensureSyncIdentity(created.id)
  if (restaurant) {
    await syncOwnerRestaurantLink(prisma, ownerId, restaurant.id)
    const mainBranch = await ensureMainBranchForRestaurant(restaurant.id)
    if (mainBranch) {
      await syncUserBranchLink(prisma, ownerId, mainBranch.id)
    }
  }
  return restaurant
}

export async function getRestaurantIdForUser(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, restaurantId: true } })
  if (!user) return null

  const restaurant = await resolveRestaurantForUser(user)
  return restaurant?.id ?? null
}

export async function getBranchIdForUser(userId: string) {
  const context = await getRestaurantContextForUser(userId)
  return context?.branchId ?? null
}

export async function getRestaurantContextForUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, restaurantId: true, branchId: true, name: true },
  })
  if (!user) return null

  const restaurant = await resolveRestaurantForUser(user)

  if (!restaurant) {
    return {
      currentUser: user,
      restaurant: null,
      branch: null,
      restaurantId: null,
      branchId: null,
      billingUserId: user.id,
    }
  }

  const branch = await resolveBranchForUser(user, restaurant.id)

  return {
    currentUser: user,
    restaurant,
    branch,
    restaurantId: restaurant.id,
    branchId: branch?.id ?? null,
    billingUserId: restaurant.ownerId,
  }
}