import { PrismaClient } from '@prisma/client'

const p = new PrismaClient()

const waiters = await p.user.findMany({
  where: { role: 'waiter' },
  select: { id: true, name: true, email: true, branchId: true, restaurantId: true },
})
console.log('WAITERS:', JSON.stringify(waiters, null, 2))

if (!waiters.length) {
  console.log('No waiter users found')
  await p.$disconnect()
  process.exit(0)
}

const restaurantId = waiters[0].restaurantId
const waiterBranchId = waiters[0].branchId

// All dishes for the restaurant
const allDishes = await p.dish.findMany({
  where: { restaurantId },
  select: { id: true, name: true, branchId: true, isActive: true },
})
console.log(`\nALL DISHES (${allDishes.length}):`, JSON.stringify(allDishes.slice(0, 10), null, 2))

// Dishes matching waiter branchId
if (waiterBranchId) {
  const branchDishes = await p.dish.findMany({
    where: { restaurantId, branchId: waiterBranchId, isActive: true },
    select: { id: true, name: true },
  })
  console.log(`\nDISHES for waiter branchId (${waiterBranchId}): ${branchDishes.length}`)
  console.log(JSON.stringify(branchDishes, null, 2))
} else {
  console.log('\nWaiter branchId is NULL — auth fix may not have run yet (waiter needs to sign out/in)')
}

// Branches
const branches = await p.restaurantBranch.findMany({
  where: { restaurantId },
  select: { id: true, name: true, isMain: true, isActive: true },
})
console.log('\nBRANCHES:', JSON.stringify(branches, null, 2))

await p.$disconnect()
