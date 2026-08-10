import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'
import { buildUpsellingReport, type UpsellCheck } from '../lib/upsellingReport'

function readEnvVar(file: string, key: string) {
  const content = fs.readFileSync(file, 'utf8')
  const line = content.split('\n').find((l) => l.startsWith(`${key}=`))
  if (!line) return undefined
  return line.slice(key.length + 1).trim().replace(/^"|"$/g, '')
}

const url = readEnvVar('.env.local', 'DATABASE_URL')
const prisma = new PrismaClient({ datasources: { db: { url } } })
const n = (v: number) => Math.round(v).toLocaleString('en-RW')

// Only real restaurants. Every account whose email is not @management.com is a
// test account, and the database is full of them — including a duplicate
// "High 5ive" under a gmail address. The API route scopes by the session's
// restaurantId so production is unaffected, but this script has to filter
// explicitly or it aggregates every test restaurant into one set of figures.
const realUsers = await prisma.user.findMany({
  where: { email: { endsWith: '@management.com' } },
  select: { id: true, email: true },
})
const realUserIds = realUsers.map((u) => u.id)
const realRestaurants = await prisma.restaurant.findMany({
  where: { OR: [{ ownerId: { in: realUserIds } }, { managerId: { in: realUserIds } }] },
  select: { id: true, name: true },
})
console.log('Real restaurants:', realRestaurants.map((r) => r.name).join(', '), '\n')
const realRestaurantIds = realRestaurants.map((r) => r.id)

const orders = await prisma.restaurantOrder.findMany({
  where: { restaurantId: { in: realRestaurantIds }, status: 'PAID', deletedAt: null },
  select: {
    id: true, staffId: true, createdByName: true, totalAmount: true, guestCount: true,
    staff: { select: { name: true } },
    items: {
      where: { status: 'ACTIVE', deletedAt: null },
      select: { id: true, dishId: true, dishName: true, qty: true, dishPrice: true },
    },
  },
})

const dishIds = Array.from(new Set(orders.flatMap((o) => o.items.map((i) => i.dishId))))
const [dishes, sales] = await Promise.all([
  prisma.dish.findMany({ where: { id: { in: dishIds } }, select: { id: true, category: true } }),
  prisma.dishSale.findMany({
    where: { orderId: { in: orders.map((o) => o.id) }, deletedAt: null },
    select: { orderItemId: true, calculatedFoodCost: true },
  }),
])
const catById = new Map(dishes.map((d) => [d.id, d.category]))
const costByOrderItemId = new Map<string, number>()
for (const s of sales) {
  if (!s.orderItemId) continue
  costByOrderItemId.set(s.orderItemId, (costByOrderItemId.get(s.orderItemId) ?? 0) + Number(s.calculatedFoodCost ?? 0))
}

const checks: UpsellCheck[] = orders.map((order) => ({
  orderId: order.id,
  staffId: order.staffId ?? null,
  staffName: order.staff?.name ?? null,
  createdByName: order.createdByName ?? null,
  totalAmount: Number(order.totalAmount ?? 0),
  guestCount: order.guestCount ?? null,
  items: order.items.map((item) => ({
    dishId: item.dishId,
    dishName: item.dishName,
    category: catById.get(item.dishId) ?? null,
    qty: Number(item.qty ?? 0),
    dishPrice: Number(item.dishPrice ?? 0),
    foodCost: costByOrderItemId.has(item.id) ? (costByOrderItemId.get(item.id) as number) : null,
  })),
}))

const r = buildUpsellingReport(checks)

console.log('=== SUMMARY ===')
console.log(`  bills             ${n(r.summary.bills)}`)
console.log(`  upsell revenue    ${n(r.summary.upsellRevenue)}`)
console.log(`  upsell cost       ${n(r.summary.upsellCost)}`)
console.log(`  upsell PROFIT     ${n(r.summary.upsellProfit)}  (${r.summary.upsellMargin}% margin)`)
console.log(`  profit per bill   ${n(r.summary.profitPerBill)}`)
console.log(`  opportunity       ${n(r.summary.opportunity)}  (top ${r.opportunities.slice(0, 3).length})`)
console.log(`  leader            ${r.summary.topServerName ?? '—'} @ ${r.summary.topServerRate ?? '—'}%`)

console.log('\n=== META ===', r.meta)

console.log('\n=== TOP OPPORTUNITIES ===')
for (const o of r.opportunities.slice(0, 5)) {
  console.log(`  ${(o.baseName + ' + ' + o.attachName).slice(0, 44).padEnd(46)} ${o.together} of ${o.baseBills} · ${o.houseRate}%  →  ${o.bestServerName} ${o.bestServerRate}%   +${n(o.missedProfit)}`)
}

console.log('\n=== PAIRINGS (top 8 by profit) ===')
console.log('  ' + 'PAIRING'.padEnd(48) + 'TOGETHER'.padStart(14) + 'PROFIT'.padStart(11) + 'MARGIN'.padStart(8) + '  CONF')
for (const p of r.pairings.slice(0, 8)) {
  console.log(
    '  ' + (p.baseName + ' + ' + p.attachName).slice(0, 47).padEnd(48) +
    `${p.together} of ${p.baseBills} · ${p.attachRate}%`.padStart(14) +
    n(p.profit).padStart(11) + `${p.margin}%`.padStart(8) + '  ' + p.confidence
  )
}

console.log('\n=== WAITERS ===')
console.log('  ' + 'WAITER'.padEnd(18) + 'BILLS'.padStart(6) + 'ATTACH'.padStart(8) + 'PROFIT/BILL'.padStart(13) + 'VS HOUSE'.padStart(11))
for (const w of r.rows.slice(0, 8)) {
  console.log(
    '  ' + w.serverName.slice(0, 17).padEnd(18) +
    String(w.checks).padStart(6) +
    (w.addonRate === null ? '—' : w.addonRate + '%').padStart(8) +
    n(w.profitPerCheck).padStart(13) +
    (w.vsHouse === null ? 'insufficient' : (w.vsHouse >= 0 ? '+' : '-') + n(Math.abs(w.vsHouse))).padStart(11)
  )
}
console.log('  ' + 'HOUSE'.padEnd(18) + String(r.house.checks).padStart(6) + (r.house.addonRate + '%').padStart(8) + n(r.house.profitPerCheck).padStart(13))

await prisma.$disconnect()
