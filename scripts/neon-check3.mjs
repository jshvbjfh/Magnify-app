import { PrismaClient } from '@prisma/client'

const p = new PrismaClient({
  datasources: { db: { url: 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&connect_timeout=30' } }
})

const branches = await p.restaurantBranch.findMany({
  where: { id: { in: ['cmoclcy030004fqycq298t6fh', 'cmocp93n702vgfqyczxqz5pr0', 'cmocpbfgm02zofqycq94wqgub'] } },
  select: { id: true, restaurantId: true, name: true, code: true, isMain: true, isActive: true }
})
console.log('BRANCHES:')
console.table(branches)

// Also check the restaurant's branches
const r = await p.restaurantBranch.findMany({
  where: { restaurantId: 'cmoclcvse0002fqyclnwcxhmw' },
  select: { id: true, name: true, code: true, isMain: true, isActive: true }
})
console.log('Branches belonging to cmoclcvse0002fqyclnwcxhmw:')
console.table(r)

// Check if there's a user with restaurantId null that shouldn't be
const brokenUsers = await p.user.findMany({
  where: { restaurantId: null, role: { in: ['admin', 'owner'] } },
  select: { id: true, email: true, role: true }
})
console.log('Admin/owner users with no restaurant:', JSON.stringify(brokenUsers))

await p.$disconnect()
