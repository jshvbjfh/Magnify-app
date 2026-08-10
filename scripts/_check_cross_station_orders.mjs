/** READ-ONLY: find how many orders contain dish items whose dish belongs to a
 *  different station/branch than the order itself. */
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

const user = await prisma.user.findUnique({ where: { email: 'high5ive@management.com' }, select: { id: true } })
const rest = await prisma.restaurant.findFirst({ where: { ownerId: user.id }, select: { id: true } })

const branches = await prisma.branch.findMany({ where: { restaurantId: rest.id }, select: { id: true, name: true } })
const branchName = new Map(branches.map(b => [b.id, b.name]))

const orders = await prisma.restaurantOrder.findMany({
  where: { restaurantId: rest.id, status: 'PAID' },
  select: {
    id: true, branchId: true, paidAt: true, orderNumber: true, tableName: true,
    table: { select: { name: true } },
    items: { where: { status: 'ACTIVE' }, select: { dishId: true, dishName: true, qty: true } },
  },
  orderBy: { paidAt: 'desc' },
  take: 500,
})

const dishIds = Array.from(new Set(orders.flatMap(o => o.items.map(i => i.dishId))))
const dishes = await prisma.dish.findMany({ where: { id: { in: dishIds } }, select: { id: true, name: true, branchId: true } })
const dishBranch = new Map(dishes.map(d => [d.id, d.branchId]))

let mixedCount = 0
const examples = []
for (const o of orders) {
  const itemBranches = new Set(o.items.map(i => dishBranch.get(i.dishId)).filter(Boolean))
  const spansMultiple = itemBranches.size > 1
  const differsFromOrder = [...itemBranches].some(b => b !== o.branchId)
  if (spansMultiple || differsFromOrder) {
    mixedCount++
    if (examples.length < 15) {
      examples.push({
        orderId: o.id,
        orderNumber: o.orderNumber,
        orderBranch: branchName.get(o.branchId) ?? o.branchId,
        table: o.table?.name ?? o.tableName,
        paidAt: o.paidAt,
        items: o.items.map(i => ({ dish: i.dishName, dishBranch: branchName.get(dishBranch.get(i.dishId)) ?? dishBranch.get(i.dishId) })),
      })
    }
  }
}

console.log(`Checked ${orders.length} recent PAID orders.`)
console.log(`Orders with items spanning multiple stations OR items outside the order's own station: ${mixedCount}`)
console.log('\n=== Examples ===')
for (const e of examples) {
  console.log(`\nOrder ${e.orderNumber} (${e.orderId}) | till/order branch: ${e.orderBranch} | table: ${e.table} | paid: ${e.paidAt}`)
  for (const it of e.items) console.log(`   - ${it.dish} -> ${it.dishBranch}`)
}

await prisma.$disconnect()
