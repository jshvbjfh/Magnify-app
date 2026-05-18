import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'

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

  while (await db.branch.findFirst({ where: { restaurantId, code } })) {
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

export async function ensureMainBranchForRestaurant(restaurantId: string, db: PrismaDb = prisma) {
  const existingMain = await db.branch.findFirst({
    where: { restaurantId, isMain: true },
    orderBy: { createdAt: 'asc' },
  })
  if (existingMain) return existingMain

  const existingDefaultCode = await db.branch.findFirst({
    where: { restaurantId, code: DEFAULT_BRANCH_CODE },
    orderBy: { createdAt: 'asc' },
  })
  if (existingDefaultCode) {
    return db.branch.update({
      where: { id: existingDefaultCode.id },
      data: {
        isMain: true,
        isActive: true,
      },
    })
  }

  const restaurant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { id: true },
  })
  if (!restaurant) return null

  return db.branch.create({
    data: {
      restaurantId,
      name: DEFAULT_BRANCH_NAME,
      code: await uniqueBranchCode(db, restaurantId, DEFAULT_BRANCH_CODE),
      isMain: true,
      isActive: true,
    },
  })
}

export async function isMainBranch(restaurantId: string, branchId: string, db: PrismaDb = prisma) {
  const branch = await db.branch.findFirst({
    where: { id: branchId, restaurantId },
    select: { isMain: true },
  })

  return Boolean(branch?.isMain)
}

export async function createBranch(
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

  const existingBranches = await db.branch.findMany({
    where: { restaurantId },
    select: { name: true },
  })

  if (existingBranches.some((branch) => normalizeBranchName(branch.name).toLowerCase() === name.toLowerCase())) {
    throw new Error('A branch with this name already exists')
  }

  return db.branch.create({
    data: {
      restaurantId,
      name,
      code: await uniqueBranchCode(db, restaurantId, params.code || name),
      isMain: false,
      isActive: true,
    },
  })
}

export async function findOwnedRestaurant(ownerId: string) {
  return prisma.restaurant.findFirst({ where: { ownerId }, orderBy: { createdAt: 'asc' } })
}

export async function ensureRestaurantForOwner(ownerId: string) {
  const existing = await findOwnedRestaurant(ownerId)
  if (existing) {
    await ensureMainBranchForRestaurant(existing.id)
    return existing
  }

  const user = await prisma.user.findUnique({ where: { id: ownerId }, select: { id: true, name: true } })
  if (!user) {
    throw Object.assign(new Error('Session refers to a deleted account; please sign in again'), { code: 'USER_NOT_FOUND' })
  }

  const joinCode = await uniqueJoinCode()

  const created = await prisma.restaurant.create({
    data: {
      name: getDefaultRestaurantName(user.name),
      ownerId,
      joinCode,
    },
  })

  await ensureMainBranchForRestaurant(created.id)
  return created
}

export async function getRestaurantIdForUser(userId: string) {
  const context = await getRestaurantContextForUser(userId)
  return context?.restaurantId ?? null
}

export async function getBranchIdForUser(userId: string) {
  const context = await getRestaurantContextForUser(userId)
  return context?.branchId ?? null
}

export async function getRestaurantContextForUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, name: true },
  })
  if (!user) return null

  // admin (manager) — finds restaurant they manage via managerId
  // owner (investor) — finds restaurant they own via ownerId
  // Both fall back to ownerId for legacy records created before managerId existed
  const restaurant = user.role === 'admin'
    ? await prisma.restaurant.findFirst({
        where: { OR: [{ managerId: user.id }, { ownerId: user.id }], deletedAt: null },
        orderBy: { createdAt: 'asc' },
      })
    : await findOwnedRestaurant(user.id)

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

  const branch = await ensureMainBranchForRestaurant(restaurant.id)

  return {
    currentUser: user,
    restaurant,
    branch,
    restaurantId: restaurant.id,
    branchId: branch?.id ?? null,
    billingUserId: restaurant.ownerId,
  }
}
