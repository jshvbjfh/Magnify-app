/** READ-ONLY: (1) SODA dish ingredients + 'soda' stock item in Parking Bar,
 *  (2) all dishes that are soft-deleted but still isActive (pull-route leak). */
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

const PARKING = 'cmqiagbtb0010n5p1utvhc8s6'

// 1. SODA dish full state
const soda = await prisma.dish.findUnique({
  where: { id: 'cmrkrl2og004l12s2ggbncv8n' },
  select: {
    name: true, category: true, sellingPrice: true, isActive: true, deletedAt: true, menuType: true,
    ingredients: { select: { inventoryItemId: true, quantityRequired: true, unit: true, inventoryItem: { select: { name: true, unit: true, quantity: true, unitCost: true, branchId: true } } } },
  },
})
console.log('=== SODA dish ===')
console.log(JSON.stringify(soda, null, 2))

// 2. soda-like stock items in Parking Bar
const sodaStock = await prisma.inventoryItem.findMany({
  where: { branchId: PARKING, name: { contains: 'oda' } },
  select: { id: true, name: true, unit: true, quantity: true, unitCost: true, deletedAt: true },
})
console.log('\n=== soda-like stock items in Parking Bar ===')
console.log(JSON.stringify(sodaStock, null, 2))

// 3. Deleted-but-active dishes leaking into the waiter pull, restaurant-wide
const user = await prisma.user.findUnique({ where: { email: 'high5ive@management.com' }, select: { id: true } })
const rest = await prisma.restaurant.findFirst({ where: { ownerId: user.id }, select: { id: true } })
const leaks = await prisma.dish.findMany({
  where: { restaurantId: rest.id, isActive: true, deletedAt: { not: null } },
  select: { name: true, deletedAt: true, branch: { select: { name: true } } },
  orderBy: { deletedAt: 'desc' },
})
console.log(`\n=== Soft-deleted but still isActive (leaking into tills): ${leaks.length} ===`)
for (const d of leaks) console.log(`  ${d.branch.name} | ${d.name} — deleted ${d.deletedAt.toISOString()}`)

await prisma.$disconnect()
