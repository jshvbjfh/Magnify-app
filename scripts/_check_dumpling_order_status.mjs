/** READ-ONLY: check the RestaurantOrder for the 2026-07-14 dumpling sale to see
 *  why the dish-profitability report (Cost of Goods card) shows 0 even though
 *  the DishSale.calculatedFoodCost for it is 717.966. */
import { createRequire } from 'module'
import { resolve } from 'path'
import { readFileSync } from 'fs'
for (const file of ['.env.local', '.env']) {
  try {
    for (const line of readFileSync(resolve(process.cwd(), file), 'utf8').split('\n')) {
      const t = line.trim(); if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('='); if (eq < 0) continue
      const k = t.slice(0, eq).trim(), v = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
      if (!process.env[k]) process.env[k] = v
    }
  } catch {}
}
const require = createRequire(import.meta.url)
const { PrismaClient } = require('@prisma/client')
const url = new URL(process.env.DATABASE_URL)
url.searchParams.set('connection_limit', '3')
url.searchParams.set('pool_timeout', '30')
const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } })

const order = await prisma.restaurantOrder.findUnique({
  where: { id: '0cecc78b-4583-4c3d-9955-1cf700f1328a' },
  select: {
    id: true, status: true, branchId: true, paidAt: true, createdAt: true, totalAmount: true, restaurantId: true,
    branch: { select: { name: true } },
    items: { select: { id: true, dishId: true, dishName: true, qty: true, status: true } },
  },
})
console.log(JSON.stringify(order, null, 2))

const sale = await prisma.dishSale.findFirst({
  where: { orderId: '0cecc78b-4583-4c3d-9955-1cf700f1328a' },
  select: { id: true, orderId: true, restaurantId: true, branchId: true, calculatedFoodCost: true },
})
console.log('\nDishSale row:', JSON.stringify(sale, null, 2))

await prisma.$disconnect()
