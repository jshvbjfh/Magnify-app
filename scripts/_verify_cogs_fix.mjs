/** READ-ONLY: replicate the new dish-profitability query logic for Little
 *  Taipei on 2026-07-14 to confirm Cost of Goods now shows ~718, not 0. */
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
const branchId = 'cmqiad2vx000in5p176jvqush' // Little Taipei
const fromDate = new Date('2026-07-14T00:00:00')
const toDate = new Date('2026-07-14T23:59:59.999')

const orders = await prisma.restaurantOrder.findMany({
  where: { restaurantId, status: 'PAID', paidAt: { gte: fromDate, lte: toDate } },
  include: { table: { select: { name: true } }, items: { where: { status: 'ACTIVE' }, orderBy: { createdAt: 'asc' } } },
  orderBy: { paidAt: 'desc' },
})

const orderIds = orders.map(o => o.id)
const dishIds = Array.from(new Set(orders.flatMap(o => o.items.map(i => i.dishId))))

const sales = await prisma.dishSale.findMany({
  where: { orderId: { in: orderIds }, restaurantId, branchId, deletedAt: null },
  select: { orderId: true, orderItemId: true, calculatedFoodCost: true },
})
const dishes = await prisma.dish.findMany({
  where: { id: { in: dishIds }, restaurantId },
  include: { ingredients: { include: { inventoryItem: { select: { unitCost: true } } } } },
})
const dishById = new Map(dishes.map(d => [d.id, d]))
const actualCostByOrderItemId = new Map()
for (const s of sales) { if (s.orderItemId) actualCostByOrderItemId.set(s.orderItemId, (actualCostByOrderItemId.get(s.orderItemId) ?? 0) + Number(s.calculatedFoodCost ?? 0)) }
const estimatedUnitCostByDishId = new Map(dishes.map(d => [d.id, d.ingredients.reduce((s, ir) => s + Number(ir.quantityRequired ?? 0) * Number(ir.inventoryItem.unitCost ?? 0), 0)]))

let totalRevenue = 0, totalCost = 0
for (const order of orders) {
  const stationItems = order.items.filter(item => dishById.get(item.dishId)?.branchId === branchId)
  if (stationItems.length === 0) continue
  const totalPrice = stationItems.reduce((s, i) => s + Number(i.qty ?? 0) * Number(i.dishPrice ?? 0), 0)
  const cost = stationItems.reduce((s, i) => {
    const actual = actualCostByOrderItemId.get(i.id)
    if (actual !== undefined) return s + actual
    return s + Number(i.qty ?? 0) * Number(estimatedUnitCostByDishId.get(i.dishId) ?? 0)
  }, 0)
  console.log(`Order ${order.orderNumber}: items=${stationItems.map(i=>i.dishName).join(', ')} revenue=${totalPrice} cost=${cost}`)
  totalRevenue += totalPrice
  totalCost += cost
}
console.log(`\nLittle Taipei 2026-07-14 -> Revenue=${totalRevenue} Cost=${totalCost} Profit=${totalRevenue-totalCost}`)

await prisma.$disconnect()
