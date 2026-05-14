import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PrismaClient } from '@prisma/client'

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue
    const key = trimmed.slice(0, eqIndex).trim()
    const value = trimmed.slice(eqIndex + 1).trim().replace(/^['"]|['"]$/g, '')
    if (!process.env[key]) process.env[key] = value
  }
}

loadEnvFile(resolve(process.cwd(), '.env.local'))
loadEnvFile(resolve(process.cwd(), '.env'))

const prisma = new PrismaClient()

// List restaurants with their branch counts and dish counts
const restaurants = await prisma.restaurant.findMany({
  select: { id: true, name: true, ownerId: true }
})

for (const r of restaurants) {
  const branches = await prisma.restaurantBranch.findMany({
    where: { restaurantId: r.id, isActive: true },
    select: { id: true, name: true }
  })
  const totalDishes = await prisma.dish.count({ where: { restaurantId: r.id } })
  const nullBranchDishes = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) as cnt FROM dishes WHERE "restaurantId" = $1 AND "branchId" IS NULL`, r.id
  )
  const users = await prisma.user.findMany({
    where: { restaurantId: r.id, role: { in: ['waiter', 'kitchen'] } },
    select: { id: true, email: true, role: true, branchId: true }
  })

  console.log(`\nRestaurant: ${r.name} (${r.id})`)
  console.log(`  Branches (active): ${branches.map(b => `${b.name} [${b.id}]`).join(', ') || 'NONE'}`)
  console.log(`  Total dishes: ${totalDishes}  (${nullBranchDishes[0].cnt} with null branchId)`)
  console.log(`  Waiter/kitchen accounts: ${users.length}`)
  for (const u of users) {
    const branchMatch = branches.find(b => b.id === u.branchId)
    console.log(`    ${u.role} ${u.email}: branchId=${u.branchId ?? 'NULL'} ${branchMatch ? '✓' : '⚠ no branch match'}`)
  }
  
  // Check dish branchIds vs actual branches
  if (totalDishes > 0 && branches.length > 0) {
    for (const b of branches) {
      const dishCount = await prisma.dish.count({ where: { restaurantId: r.id, branchId: b.id } })
      console.log(`  Dishes for branch [${b.name}]: ${dishCount}`)
    }
  }
}

await prisma.$disconnect()
