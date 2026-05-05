import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient({
  datasources: { db: { url: 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&connect_timeout=30' } }
})

const users = await prisma.user.findMany({
  select: { id: true, email: true, role: true, restaurantId: true, branchId: true, isActive: true }
})
console.log('=== USERS IN NEON ===')
console.table(users)

const restaurants = await prisma.restaurant.findMany({
  select: { id: true, name: true, ownerId: true, syncRestaurantId: true }
})
console.log('=== RESTAURANTS ===')
console.table(restaurants)

const branches = await prisma.restaurantBranch.findMany({
  select: { id: true, name: true, restaurantId: true, isMain: true, isActive: true }
})
console.log('=== BRANCHES ===')
console.table(branches)

const txnCounts = await prisma.transaction.groupBy({
  by: ['restaurantId'],
  _count: { id: true },
})
console.log('=== TRANSACTIONS PER RESTAURANT ===')
console.table(txnCounts)

const batches = await prisma.restaurantSyncBatch.findMany({
  select: { restaurantId: true, status: true, syncedTransactions: true, syncedSummaries: true, createdAt: true },
  orderBy: { createdAt: 'desc' },
  take: 10,
})
console.log('=== RECENT SYNC BATCHES (last 10) ===')
console.table(batches)

const outbox = await prisma.syncOutbox.groupBy({
  by: ['entityType'],
  _count: { id: true },
})
console.log('=== OUTBOX ENTITY COUNTS ===')
console.table(outbox)

const dishes = await prisma.dish.findMany({
  select: { id: true, name: true, restaurantId: true, branchId: true },
  take: 10,
})
console.log('=== DISHES IN NEON ===')
console.table(dishes)

const inv = await prisma.inventoryItem.findMany({
  select: { id: true, name: true, restaurantId: true, branchId: true },
  take: 10,
})
console.log('=== INVENTORY IN NEON ===')
console.table(inv)

await prisma.$disconnect()

