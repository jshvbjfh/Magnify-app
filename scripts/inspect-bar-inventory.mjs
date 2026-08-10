/**
 * READ-ONLY: Show all inventory items for Banana Bar and Parking Bar
 */
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
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })

const user = await prisma.user.findUnique({ where: { email: 'high5ive@management.com' }, select: { id: true } })
const rest = await prisma.restaurant.findFirst({ where: { ownerId: user.id }, select: { id: true, name: true } })
const branches = await prisma.branch.findMany({
  where: { restaurantId: rest.id, type: 'bar' },
  select: { id: true, name: true },
  orderBy: { name: 'asc' },
})

for (const b of branches) {
  const items = await prisma.inventoryItem.findMany({
    where: { branchId: b.id, deletedAt: null },
    select: { id: true, name: true, unit: true, unitCost: true, quantity: true, category: true },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
  })
  console.log(`\n${'═'.repeat(60)}`)
  console.log(`${b.name} — ${items.length} inventory items`)
  let cat = null
  for (const i of items) {
    if (i.category !== cat) { cat = i.category; console.log(`\n  [${cat ?? 'Uncategorised'}]`) }
    console.log(`  ${i.name}  qty:${i.quantity}${i.unit}  cost:${i.unitCost} RWF/${i.unit}  id:${i.id}`)
  }
  if (!items.length) console.log('  (no inventory items)')
}

await prisma.$disconnect()
