import { prisma } from '@/lib/prisma'
import { randomBytes } from 'crypto'

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

async function ensureSyncIdentity(restaurantId: string) {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { id: true, name: true, syncRestaurantId: true, syncToken: true },
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
  })
}

export async function findOwnedRestaurant(ownerId: string) {
  return prisma.restaurant.findFirst({ where: { ownerId }, orderBy: { createdAt: 'asc' } })
}

export async function ensureRestaurantForOwner(ownerId: string) {
  const existing = await findOwnedRestaurant(ownerId)
  if (existing) {
    return ensureSyncIdentity(existing.id)
  }

  const user = await prisma.user.findUnique({ where: { id: ownerId }, select: { name: true } })
  const joinCode = await uniqueJoinCode()

  const created = await prisma.restaurant.create({
    data: {
      name: user?.name ? `${user.name}'s Restaurant` : 'My Restaurant',
      ownerId,
      joinCode,
      syncRestaurantId: makeSyncRestaurantId(),
      syncToken: makeSyncToken(),
    },
  })

  return ensureSyncIdentity(created.id)
}

export async function getRestaurantIdForUser(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { restaurantId: true } })
  if (user?.restaurantId) return user.restaurantId

  const owned = await findOwnedRestaurant(userId)
  return owned?.id ?? null
}