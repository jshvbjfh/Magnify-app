import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: 'file:C:\\Users\\HP\\AppData\\Roaming\\restaurant-app\\data\\dev.db'
    }
  }
})

try {
  const restaurants = await prisma.restaurant.findMany({ select: { id: true, name: true, syncRestaurantId: true } })
  console.log('\nLOCAL Restaurants:', JSON.stringify(restaurants, null, 2))

  const users = await prisma.user.findMany({ select: { id: true, email: true, role: true, restaurantId: true, branchId: true } })
  console.log('\nLOCAL Users:', JSON.stringify(users, null, 2))

  const dishCount = await prisma.dish.count()
  const invCount = await prisma.inventoryItem.count()
  const txTotal = await prisma.transaction.count()
  const txUnsynced = await prisma.transaction.count({ where: { synced: false } })
  const outboxCount = await prisma.syncOutbox.count()
  console.log('\nLOCAL counts - dishes:', dishCount, '| inventory:', invCount, '| tx total:', txTotal, '| tx unsynced:', txUnsynced, '| outbox:', outboxCount)

  const branches = await prisma.restaurantBranch.findMany({ select: { id: true, name: true, isMain: true, restaurantId: true } })
  console.log('\nLOCAL Branches:', JSON.stringify(branches, null, 2))
} finally {
  await prisma.$disconnect()
}
