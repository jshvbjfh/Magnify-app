/**
 * Redistributes all dishes from the "Main" branch to their appropriate department branches.
 * Scoped to the testmanager account's restaurant.
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
require('dotenv').config({ path: '.env.local' })

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const ADMIN_EMAIL = 'testmanager@magnify.test'

const DISH_BRANCH_MAP = {
  'Margherita Pizza': 'BBQ',
  'Pepperoni Pizza': 'BBQ',
  'BBQ Chicken Pizza': 'BBQ',
  'Four Cheese Pizza': 'BBQ',
  'Vegetarian Pizza': 'BBQ',
  'Grilled Chicken': 'BBQ',
  'Beef Burger': 'BBQ',
  'Chicken Wings': 'BBQ',
  'Fish and Chips': 'BBQ',
  'Rum and Coke': 'Bar',
  'Vodka Tonic': 'Bar',
  'Whiskey Single': 'Bar',
  'Local Draft Beer': 'Bar',
  'Corona 330ml': 'Bar',
  'Guinness 500ml': 'Bar',
  'Heineken 330ml': 'Bar',
  'Soda': 'Lounge',
  'Pasta Carbonara': 'Lounge',
  'French Fries': 'Lounge',
  'Garlic Bread': 'Lounge',
  'Onion Rings': 'Lounge',
  'Caesar Salad': 'Bakery',
  'Coleslaw': 'Bakery',
  'Garden Salad': 'Bakery',
  'Greek Salad': 'Bakery',
}

async function run() {
  // Find the admin user and their restaurant
  const user = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL }, select: { id: true, role: true } })
  if (!user) { console.error(`User not found: ${ADMIN_EMAIL}`); process.exit(1) }

  const restaurant = await prisma.restaurant.findFirst({
    where: { OR: [{ managerId: user.id }, { ownerId: user.id }], deletedAt: null },
    orderBy: { createdAt: 'asc' },
  })
  if (!restaurant) { console.error('Restaurant not found'); process.exit(1) }

  console.log(`Restaurant: ${restaurant.name} (${restaurant.id})`)

  const branches = await prisma.branch.findMany({
    where: { restaurantId: restaurant.id, isActive: true },
  })
  const branchByName = Object.fromEntries(branches.map(b => [b.name, b]))
  console.log('Branches:', branches.map(b => `${b.name} (${b.id.slice(-6)})`).join(', '))

  const mainBranch = branches.find(b => b.name === 'Main')
  if (!mainBranch) { console.error('Main branch not found'); process.exit(1) }

  const dishes = await prisma.dish.findMany({
    where: { restaurantId: restaurant.id, branchId: mainBranch.id, deletedAt: null },
    select: { id: true, name: true },
  })
  console.log(`\nDishes in Main (${dishes.length}):`, dishes.map(d => d.name).join(', '))

  let moved = 0, skipped = 0
  for (const dish of dishes) {
    const targetBranchName = DISH_BRANCH_MAP[dish.name]
    if (!targetBranchName) {
      console.log(`  SKIP (no mapping): ${dish.name}`)
      skipped++
      continue
    }
    const targetBranch = branchByName[targetBranchName]
    if (!targetBranch) {
      console.log(`  SKIP (branch not found): ${dish.name} -> ${targetBranchName}`)
      skipped++
      continue
    }
    await prisma.dish.update({ where: { id: dish.id }, data: { branchId: targetBranch.id } })
    console.log(`  Moved: "${dish.name}" -> ${targetBranchName}`)
    moved++
  }

  console.log(`\nDone. Moved: ${moved}, Skipped: ${skipped}`)

  const grouped = await prisma.dish.groupBy({
    by: ['branchId'],
    _count: { id: true },
    where: { restaurantId: restaurant.id, deletedAt: null },
  })
  for (const g of grouped) {
    const b = branches.find(br => br.id === g.branchId)
    console.log(`  ${b?.name ?? g.branchId}: ${g._count.id} dishes`)
  }

  await prisma.$disconnect()
}

run().catch(e => { console.error(e); process.exit(1) })
