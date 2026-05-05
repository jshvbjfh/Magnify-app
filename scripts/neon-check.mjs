import { PrismaClient } from '@prisma/client'

const p = new PrismaClient({
  datasources: { db: { url: 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&connect_timeout=30' } }
})

const r = await p.restaurant.findUnique({
  where: { id: 'cmoclcvse0002fqyclnwcxhmw' },
  select: { id: true, name: true, ownerId: true, syncRestaurantId: true }
})
console.log('RESTAURANT:', JSON.stringify(r, null, 2))

if (r?.ownerId) {
  const owner = await p.user.findUnique({
    where: { id: r.ownerId },
    select: { id: true, email: true, role: true, restaurantId: true, branchId: true }
  })
  console.log('OWNER USER:', JSON.stringify(owner, null, 2))
}

// Also check chezjohn2owner
const cjOwner = await p.user.findUnique({
  where: { email: 'chezjohn2owner@gmail.com' },
  select: { id: true, email: true, role: true, restaurantId: true, branchId: true }
})
console.log('chezjohn2owner in Neon:', JSON.stringify(cjOwner, null, 2))

await p.$disconnect()
