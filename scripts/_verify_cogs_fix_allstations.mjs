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
url.searchParams.set('connection_limit', '2')
url.searchParams.set('pool_timeout', '30')
const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } })

const restaurantId = 'cmqia7buf0003n5p19gkoov3k'
const fromDate = new Date('2026-07-14T00:00:00')
const toDate = new Date('2026-07-14T23:59:59.999')

const orders = await prisma.restaurantOrder.findMany({
  where: { restaurantId, status: 'PAID', paidAt: { gte: fromDate, lte: toDate } },
  select: { id: true, orderNumber: true, totalAmount: true, items: { where: { status: 'ACTIVE' }, select: { id: true, dishId: true, dishName: true, dishPrice: true, qty: true } } },
})

const dishIds = Array.from(new Set(orders.flatMap(o => o.items.map(i => i.dishId))))
const dishes = await prisma.dish.findMany({ where: { id: { in: dishIds } }, select: { id: true, name: true, branchId: true, deletedAt: true } })
const dishById = new Map(dishes.map(d => [d.id, d]))

let sumFromItems = 0
let sumOrderTotal = 0
let unmatchedItems = []
for (const o of orders) {
  sumOrderTotal += Number(o.totalAmount ?? 0)
  for (const item of o.items) {
    const dish = dishById.get(item.dishId)
    sumFromItems += Number(item.qty ?? 0) * Number(item.dishPrice ?? 0)
    if (!dish) unmatchedItems.push({ order: o.orderNumber, item: item.dishName, reason: 'dish not found' })
  }
}

console.log(`Orders on 2026-07-14: ${orders.length}`)
console.log(`Sum of order.totalAmount: ${sumOrderTotal}`)
console.log(`Sum of (item.qty * item.dishPrice) across all items: ${sumFromItems}`)
console.log(`Unmatched items (no dish record found): ${unmatchedItems.length}`)
for (const u of unmatchedItems) console.log('  ', u)

await prisma.$disconnect()
