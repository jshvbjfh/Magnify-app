import { PrismaClient } from '@prisma/client'

const p = new PrismaClient()

const RESTAURANT_ID = 'cmodfis4i0002raaqaq288m0v'
const CORRECT_BRANCH_ID = 'cmodfiszn0004raaq9u8vrr73' // Main branch

// Find dishes with wrong branchId
const orphanedDishes = await p.dish.findMany({
  where: { restaurantId: RESTAURANT_ID, NOT: { branchId: CORRECT_BRANCH_ID } },
  select: { id: true, name: true, branchId: true }
})
console.log('Orphaned dishes:', JSON.stringify(orphanedDishes, null, 2))

if (orphanedDishes.length === 0) {
  console.log('Nothing to fix')
  await p.$disconnect()
  process.exit(0)
}

// Update them to the correct branch
const result = await p.dish.updateMany({
  where: { restaurantId: RESTAURANT_ID, NOT: { branchId: CORRECT_BRANCH_ID } },
  data: { branchId: CORRECT_BRANCH_ID }
})
console.log(`\nFixed ${result.count} dishes → moved to Main branch ${CORRECT_BRANCH_ID}`)

// Verify
const verifyDishes = await p.dish.findMany({
  where: { restaurantId: RESTAURANT_ID, branchId: CORRECT_BRANCH_ID, isActive: true },
  select: { id: true, name: true, branchId: true }
})
console.log('\nDishes now on correct branch:', JSON.stringify(verifyDishes, null, 2))

await p.$disconnect()
