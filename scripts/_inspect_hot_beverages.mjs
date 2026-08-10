/** READ-ONLY: Parking Bar Hot Beverages — dishes, recipes, backing stock
 *  items, and whether that stock is shared with dishes that stay behind. */
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
const BANANA = 'cmqiafute000vn5p1zcngyawx'

const hotBevs = await prisma.dish.findMany({
  where: { branchId: PARKING, category: 'Hot Beverages', deletedAt: null },
  select: {
    id: true, name: true, sellingPrice: true, isActive: true,
    ingredients: { select: { quantityRequired: true, unit: true, inventoryItem: { select: { id: true, name: true, unit: true, quantity: true, unitCost: true, type: true } } } },
  },
  orderBy: { name: 'asc' },
})

const usedItemIds = new Set()
console.log(`=== Parking Bar Hot Beverages (${hotBevs.length}) ===`)
for (const d of hotBevs) {
  console.log(`${d.name} @ ${d.sellingPrice}${d.isActive ? '' : ' [INACTIVE]'}`)
  if (!d.ingredients.length) console.log('    (no recipe)')
  for (const i of d.ingredients) {
    usedItemIds.add(i.inventoryItem.id)
    console.log(`    ${i.inventoryItem.name}: ${i.quantityRequired}${i.unit ?? i.inventoryItem.unit} (stock ${i.inventoryItem.quantity}${i.inventoryItem.unit} @ ${i.inventoryItem.unitCost}, ${i.inventoryItem.type})`)
  }
}

// For each used stock item: what ELSE uses it (dishes staying in Parking Bar,
// or preps), and how many purchase batches it has.
console.log('\n=== Stock items used by hot beverages — other usages ===')
for (const itemId of usedItemIds) {
  const item = await prisma.inventoryItem.findUnique({
    where: { id: itemId },
    select: {
      name: true, unit: true, quantity: true,
      _count: { select: { purchases: true, batchUsageLedgers: true } },
      dishIngredients: { select: { dish: { select: { name: true, category: true, branchId: true, deletedAt: true, isActive: true } } } },
      usedInPreps: { select: { prepItem: { select: { name: true } } } },
    },
  })
  const otherUses = item.dishIngredients.filter(di => !di.dish.deletedAt && di.dish.category !== 'Hot Beverages')
  const flag = otherUses.length || item.usedInPreps.length ? '⚠ SHARED' : 'exclusive'
  console.log(`${item.name} (${item.quantity}${item.unit}, ${item._count.purchases} batches, ${item._count.batchUsageLedgers} ledgers) — ${flag}`)
  for (const u of otherUses) console.log(`    also used by: ${u.dish.category ?? '-'} | ${u.dish.name}`)
  for (const p of item.usedInPreps) console.log(`    used in prep: ${p.prepItem.name}`)
}

// Existing Banana Bar items that would collide by name
const bananaNames = await prisma.inventoryItem.findMany({
  where: { branchId: BANANA, deletedAt: null },
  select: { name: true },
})
const bananaSet = new Set(bananaNames.map(i => i.name.toLowerCase()))
console.log('\n=== Name collisions in Banana Bar stock ===')
let collisions = 0
for (const itemId of usedItemIds) {
  const item = await prisma.inventoryItem.findUnique({ where: { id: itemId }, select: { name: true } })
  if (bananaSet.has(item.name.toLowerCase())) { collisions++; console.log(`  ⚠ ${item.name} already exists in Banana Bar`) }
}
if (!collisions) console.log('  (none)')

// Also check: Banana Bar dish-name collisions
const bananaDishes = await prisma.dish.findMany({ where: { branchId: BANANA, deletedAt: null }, select: { name: true } })
const bananaDishSet = new Set(bananaDishes.map(d => d.name.toLowerCase()))
console.log('\n=== Dish-name collisions in Banana Bar ===')
let dishCollisions = 0
for (const d of hotBevs) {
  if (bananaDishSet.has(d.name.toLowerCase())) { dishCollisions++; console.log(`  ⚠ ${d.name}`) }
}
if (!dishCollisions) console.log('  (none)')

await prisma.$disconnect()
