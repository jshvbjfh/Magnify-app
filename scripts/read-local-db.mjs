import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient({
  datasources: { db: { url: 'file:C:/Users/HP/AppData/Roaming/restaurant-app/data/dev.db' } }
})

const restaurants = await prisma.restaurant.findMany({
  select: { id: true, name: true, ownerId: true, syncRestaurantId: true, syncToken: true }
})
console.log('=== LOCAL RESTAURANTS ===')
console.table(restaurants)

const users = await prisma.user.findMany({
  where: { role: { in: ['admin', 'owner'] } },
  select: { id: true, email: true, role: true, restaurantId: true, branchId: true, isActive: true }
})
console.log('=== LOCAL ADMIN/OWNER USERS ===')
console.table(users)

const branches = await prisma.restaurantBranch.findMany({
  select: { id: true, restaurantId: true, name: true, code: true, isMain: true, isActive: true }
})
console.log('=== LOCAL BRANCHES ===')
console.table(branches)

await prisma.$disconnect()
