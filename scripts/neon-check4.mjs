import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient({ datasources: { db: { url: 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&connect_timeout=30' } } })

const restaurants = await prisma.restaurant.findMany({ select: { id: true, name: true, ownerId: true } })
console.log('Restaurants:', JSON.stringify(restaurants, null, 2))

const users = await prisma.user.findMany({
  where: { email: { in: ['chezjohn2owner@gmail.com', 'chezjohn2@gmail.com'] } },
  select: { id: true, email: true, role: true, restaurantId: true, branchId: true }
})
console.log('Key users:', JSON.stringify(users, null, 2))

const branches = await prisma.restaurantBranch.findMany({ select: { id: true, name: true, restaurantId: true, isMain: true } })
console.log('Branches:', JSON.stringify(branches, null, 2))

await prisma.$disconnect()
