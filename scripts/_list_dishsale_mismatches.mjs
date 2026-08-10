import { createRequire } from 'module'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const { PrismaClient } = require('@prisma/client')

function readEnvVar(file, key) {
  const content = fs.readFileSync(file, 'utf8')
  const line = content.split('\n').find(l => l.startsWith(`${key}=`))
  if (!line) return null
  return line.slice(key.length + 1).trim().replace(/^"|"$/g, '')
}

const url = readEnvVar('.env.local', 'DATABASE_URL')
const prisma = new PrismaClient({ datasources: { db: { url } } })

const allSales = await prisma.dishSale.findMany({
  select: {
    id: true, dishId: true, dishName: true, branchId: true, saleDate: true,
    totalSaleAmount: true, calculatedFoodCost: true, restaurantId: true, orderId: true,
  },
})
const dishIds = [...new Set(allSales.map(s => s.dishId))]
const dishes = await prisma.dish.findMany({
  where: { id: { in: dishIds } },
  select: { id: true, name: true, branchId: true },
})
const dishById = new Map(dishes.map(d => [d.id, d]))
const branches = await prisma.branch.findMany({ select: { id: true, name: true, restaurantId: true } })
const branchById = new Map(branches.map(b => [b.id, b]))
const restaurants = await prisma.restaurant.findMany({ select: { id: true, name: true } })
const restaurantById = new Map(restaurants.map(r => [r.id, r]))

const mismatches = allSales.filter(s => {
  const d = dishById.get(s.dishId)
  return d && d.branchId !== s.branchId
})

console.log(`Total mismatched DishSale rows: ${mismatches.length}\n`)

for (const m of mismatches.sort((a, b) => a.saleDate - b.saleDate)) {
  const d = dishById.get(m.dishId)
  const restaurant = restaurantById.get(m.restaurantId)
  const saleBranch = branchById.get(m.branchId)
  const currentBranch = branchById.get(d.branchId)
  console.log([
    `dishSaleId=${m.id}`,
    `restaurant="${restaurant?.name ?? m.restaurantId}"`,
    `dish="${m.dishName}"`,
    `dishId=${m.dishId}`,
    `orderId=${m.orderId}`,
    `saleDate=${m.saleDate.toISOString()}`,
    `amount=${m.totalSaleAmount}`,
    `foodCost=${m.calculatedFoodCost}`,
    `sale.branchId=${m.branchId} (${saleBranch ? saleBranch.name : 'NO MATCHING BRANCH'})`,
    `dish.currentBranchId=${d.branchId} (${currentBranch ? currentBranch.name : 'NO MATCHING BRANCH'})`,
  ].join(' | '))
}

await prisma.$disconnect()
