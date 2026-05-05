import { PrismaClient } from '@prisma/client'

const local = new PrismaClient({
  datasources: { db: { url: 'file:C:\\Users\\HP\\AppData\\Roaming\\restaurant-app\\data\\dev.db' } }
})

try {
  // Get chezjohn2@gmail.com from local SQLite
  const admin = await local.user.findFirst({
    where: { email: 'chezjohn2@gmail.com' },
    select: { id: true, email: true, name: true, role: true, password: true, restaurantId: true, branchId: true }
  })
  console.log('LOCAL chezjohn2 admin:', JSON.stringify(admin, null, 2))

  // Also get outbox counts per restaurant for local
  const outboxPerRestaurant = await local.$queryRaw`
    SELECT scopeId, COUNT(*) as count FROM SyncOutbox GROUP BY scopeId
  `
  console.log('\nOUTBOX per restaurant (local):', JSON.stringify(outboxPerRestaurant, null, 2))

  // Transactions per restaurant
  const txPerRestaurant = await local.$queryRaw`
    SELECT restaurantId, COUNT(*) as total, SUM(CASE WHEN synced = 0 THEN 1 ELSE 0 END) as unsynced 
    FROM "Transaction" GROUP BY restaurantId
  `
  console.log('\nTransactions per restaurant (local):', JSON.stringify(txPerRestaurant, null, 2))
} finally {
  await local.$disconnect()
}
