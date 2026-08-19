import fs from 'fs'
const env = {}
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/)
  if (m) env[m[1]] = m[2]
}
for (const k of ['DATABASE_URL', 'DIRECT_URL']) if (env[k]) process.env[k] = env[k]
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const r = await p.restaurant.findFirst({ where: { name: { contains: 'rocco', mode: 'insensitive' } }, select: { id: true, name: true } })
const tables = await p.restaurantTable.findMany({ where: { restaurantId: r.id, status: { not: 'available' } }, select: { name: true, status: true } })
console.log(`${r.name}: ${tables.length} table(s) not available`)
for (const t of tables) console.log(`  ${t.name} -> ${t.status}`)
const open = await p.restaurantOrder.findMany({ where: { restaurantId: r.id, status: { notIn: ['PAID', 'CANCELED'] } }, select: { orderNumber: true, status: true, tableName: true, tableId: true, createdByName: true } })
console.log(`\nopen orders: ${open.length}`)
for (const o of open) console.log(`  ${o.orderNumber} ${o.status} table=${o.tableName ?? '-'} tableId=${o.tableId ?? '-'} by=${o.createdByName ?? '-'}`)
await p.$disconnect()
