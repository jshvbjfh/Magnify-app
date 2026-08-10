/**
 * Little Taipei — phase 1 stock update (unambiguous items only).
 * Pending user confirmation before phase 2: Beef split, Tofu g/pcs,
 * Cabbage g/head, Ketchup→Sweet&Sour mapping, Red chili→which item,
 * Chicken powder→Chicken broth.
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

// ── Sheet items with confident system mappings ─────────────────────────────
// qty = total in "used in" unit  |  cost = RWF per g / ml / pcs
const UPDATES = [
  { name: 'Garlic (minced)',   qty: 1000,  cost: 2000  / 1000 },  // 1 KG
  { name: 'Bell pepper (mixed)', qty: 2000, cost: 1500 / 1000 }, // 2 KG green pepper
  { name: 'Egg',               qty: 60,    cost: (6500 + 5000) / 60 }, // 2 trays (30+30)
  { name: 'Soy sauce',         qty: 3800,  cost: null  },         // 2 btl × 1.9L (no cost given)
  { name: 'Sesame oil',        qty: 1400,  cost: 11280 / 700  }, // 2 btl × 700ml
  { name: 'Cornstarch',        qty: 28000, cost: 2400  / 4000 }, // 7 bags × 4kg
]

// ── Find Little Taipei branch ──────────────────────────────────────────────
const user = await prisma.user.findUnique({
  where: { email: 'high5ive@management.com' },
  select: { id: true }
})
const rest = await prisma.restaurant.findFirst({
  where: { ownerId: user.id }, select: { id: true }
})
const branch = await prisma.branch.findFirst({
  where: { restaurantId: rest.id, name: { contains: 'Taipei', mode: 'insensitive' } },
  select: { id: true, name: true }
})
if (!branch) { console.error('Little Taipei branch not found'); process.exit(1) }
console.log(`\nBranch: ${branch.name} (${branch.id})\n`)

const allItems = await prisma.inventoryItem.findMany({
  where: { branchId: branch.id, deletedAt: null },
  select: { id: true, name: true, unit: true, quantity: true, unitCost: true }
})
console.log(`Found ${allItems.length} inventory items.\n`)
console.log('─'.repeat(72))
console.log(` ${'ITEM'.padEnd(28)} ${'OLD QTY'.padStart(9)} → ${'NEW QTY'.padStart(9)}  ${'UNIT COST'.padStart(10)}`)
console.log('─'.repeat(72))

let updated = 0, notFound = []

for (const u of UPDATES) {
  const item = allItems.find(i => i.name.toLowerCase() === u.name.toLowerCase())
  if (!item) { notFound.push(u.name); continue }

  const data = { quantity: u.qty }
  if (u.cost !== null) data.unitCost = Math.round(u.cost * 100) / 100

  await prisma.inventoryItem.update({ where: { id: item.id }, data })

  const costStr = u.cost !== null ? `${(Math.round(u.cost*100)/100).toFixed(2)} RWF` : '(unchanged)'
  console.log(
    ` ${item.name.padEnd(28)} ${String(item.quantity).padStart(9)} → ${String(u.qty).padStart(9)}  ${costStr.padStart(14)}`
  )
  updated++
}

console.log('─'.repeat(72))
console.log(`\n✅ Updated ${updated} items.\n`)

if (notFound.length) {
  console.log('⚠ No match in DB (check name):')
  for (const n of notFound) console.log(`   • ${n}`)
  console.log()
}

// Show items still at zero after this run
const fresh = await prisma.inventoryItem.findMany({
  where: { branchId: branch.id, deletedAt: null, quantity: 0 },
  select: { name: true, unit: true }
})
console.log(`ℹ ${fresh.length} items still at 0:`)
for (const i of fresh) console.log(`   • ${i.name} (${i.unit})`)

await prisma.$disconnect()
