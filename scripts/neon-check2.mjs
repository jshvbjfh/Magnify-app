import { PrismaClient } from '@prisma/client'

const p = new PrismaClient({
  datasources: { db: { url: 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&connect_timeout=30' } }
})

// Check if chezjohn2@gmail.com (the local Electron admin) exists in Neon
const localAdmin = await p.user.findUnique({
  where: { email: 'chezjohn2@gmail.com' },
  select: { id: true, email: true, role: true, restaurantId: true }
})
console.log('chezjohn2@gmail.com in Neon:', JSON.stringify(localAdmin, null, 2))

// Check if local SQLite ID exists in Neon
const localId = await p.user.findUnique({
  where: { id: 'cmoconif20005xxrj978ps6dl' },
  select: { id: true, email: true }
})
console.log('Local SQLite admin ID in Neon:', JSON.stringify(localId, null, 2))

// Show all admin-role users in Neon with no restaurant or a restaurant with mismatched ownerId
const admins = await p.user.findMany({
  where: { role: { in: ['admin', 'owner'] } },
  select: { id: true, email: true, role: true, restaurantId: true, branchId: true }
})
console.log('\nAll admin/owner users in Neon:')
console.table(admins)

await p.$disconnect()
