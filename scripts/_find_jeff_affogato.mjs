// Read-only: locate the recent order for "Jeff" containing an affogato.
import fs from 'fs'
const env = {}
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/)
  if (m) env[m[1]] = m[2]
}
for (const k of ['DATABASE_URL', 'DIRECT_URL']) if (env[k]) process.env[k] = env[k]
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
console.log('DB host:', (process.env.DATABASE_URL || '').match(/@([^/:?]+)/)?.[1])

const ci = (s) => ({ contains: s, mode: 'insensitive' })
const orders = await p.restaurantOrder.findMany({
  where: {
    OR: [
      { tableName: ci('jeff') },
      { arCustomerName: ci('jeff') },
      { notes: ci('jeff') },
      { items: { some: { dishName: ci('affogato') } } },
    ],
  },
  orderBy: { createdAt: 'desc' },
  take: 25,
  include: {
    items: { select: { dishName: true, qty: true, dishPrice: true, status: true, kitchenStatus: true } },
    branch: { select: { name: true, restaurant: { select: { name: true } } } },
  },
})

console.log(`\nmatches: ${orders.length}`)
for (const o of orders) {
  console.log(`\n[${o.orderNumber}] ${o.branch?.restaurant?.name} / ${o.branch?.name} | ${o.status} | total=${o.totalAmount} | table=${o.tableName ?? '-'} | ar=${o.arCustomerName ?? '-'} | by=${o.createdByName ?? '-'} | src=${o.source ?? '-'} | ${o.createdAt.toISOString()}`)
  console.log(`   id=${o.id} restaurantId=${o.restaurantId} je=${o.journalEntryId ?? '-'} shift=${o.shiftId ?? '-'} notes=${o.notes ?? '-'}`)
  for (const it of o.items) console.log(`   - ${it.qty} x ${it.dishName} @ ${it.dishPrice} (${it.status}/${it.kitchenStatus})`)
}
await p.$disconnect()
