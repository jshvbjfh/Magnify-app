import { PrismaClient } from '@prisma/client'

const p = new PrismaClient()

// Check who owns the restaurant with branch cmodfiu6n0007141zw2pqb68g
const branch = await p.restaurantBranch.findUnique({
  where: { id: 'cmodfiu6n0007141zw2pqb68g' },
  include: {
    restaurant: {
      include: {
        owner: { select: { email: true, name: true, role: true } }
      }
    }
  }
})
console.log('Branch owning the 2 dishes:', JSON.stringify(branch, null, 2))

// Check admin for egide's restaurant
const restaurantId = 'cmodfis4i0002raaqaq288m0v'
const users = await p.user.findMany({
  where: { restaurantId },
  select: { id: true, email: true, name: true, role: true, branchId: true }
})
console.log('\nAll users in egide restaurant:', JSON.stringify(users, null, 2))

// Count total dishes for egide's restaurant
const dishCount = await p.dish.count({ where: { restaurantId } })
console.log('\nDish count for egide restaurant:', dishCount)

await p.$disconnect()
