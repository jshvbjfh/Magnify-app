/**
 * Update Tiamo Pasta inventory from manager's 24-Jun-2026 stocktake sheet.
 * Run: node scripts/update-tiamo-stock.mjs
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

// ── Parsed from stocktake sheet (24 Jun 2026) ─────────────────────────────
// qty  = total in the "used in" unit (grams / ml / pcs)
// cost = RWF per gram / ml / pcs
const UPDATES = [
  // PASTA: Maccaroni 4 bags×500g + Spaghetti 3 bags×500g  (both map to "Pasta")
  // avg cost = (4×2240 + 3×1400) / 3500 bags*grams
  { name: 'Pasta',            qty: 3500,  cost: (4*2240 + 3*1400) / 3500 },

  // Proteins (KG → g)
  { name: 'Ground beef',      qty: 3000,  cost: 8500  / 1000 },  // 3 KG
  { name: 'Chicken breast',   qty: 1000,  cost: 8000  / 1000 },  // 1 KG

  // Vegetables (KG → g)
  { name: 'Crushed tomatoes', qty: 2000,  cost: 1000  / 1000 },  // 2 KG
  { name: 'Onion',            qty: 2000,  cost: 1000  / 1000 },  // 2 KG
  { name: 'Garlic (minced)',  qty: 1000,  cost: 2000  / 1000 },  // 1 KG

  // Liquids (bottle → ml or g)
  { name: 'Olive oil',        qty: 1000,  cost: 12000 / 1000 },  // 1×1L bottle
  { name: 'Fresh cream',      qty: 2000,  cost: 10000 / 1000 },  // 2×1kg bottles

  // Dairy / dry
  { name: 'Cheddar / gouda',  qty: 900,   cost: 10000 / 900  },  // 900g pack
  { name: 'Butter',           qty: 500,   cost: 7000  / 500  },  // 1×500g pack

  // Dry goods / seasonings
  { name: 'Salt',             qty: 4000,  cost: 3500  / 1000 },  // 4 KG
  { name: 'Nutmeg',           qty: 40,    cost: 6200  / 40   },  // 1 bottle = 40g
  { name: 'Fresh basil',      qty: 1000,  cost: 5000  / 1000 },  // 1 KG (6000 pcs leaf)
]

// Items on sheet NOT loaded (no matching recipe ingredient in Tiamo):
// Parsley (50pcs/bunch), Bay leaves (20pcs/bottle), Rosemary (100pcs/bunch),
// White pepper (50g/bottle), Oregano (20g/bottle), Chicken Masala (50g/bottle),
// Chilli Flakes (40g/bottle), Thyme (20g/bottle)

// Items in recipe staying at 0 (absent from sheet = out of stock):
// Tomato paste, Parmesan, Salt & pepper

// ── Find Tiamo branch ──────────────────────────────────────────────────────
const user = await prisma.user.findUnique({
  where: { email: 'high5ive@management.com' },
  select: { id: true }
})
const rest = await prisma.restaurant.findFirst({
  where: { ownerId: user.id },
  select: { id: true }
})
const branch = await prisma.branch.findFirst({
  where: { restaurantId: rest.id, name: { contains: 'Tiamo', mode: 'insensitive' } },
  select: { id: true, name: true }
})
if (!branch) { console.error('Tiamo branch not found'); process.exit(1) }
console.log(`\nBranch: ${branch.name} (${branch.id})\n`)

// ── Fetch all inventory items for this branch ──────────────────────────────
const allItems = await prisma.inventoryItem.findMany({
  where: { branchId: branch.id, deletedAt: null },
  select: { id: true, name: true, unit: true, quantity: true, unitCost: true }
})

console.log(`Found ${allItems.length} inventory items in system.\n`)
console.log('─'.repeat(70))
console.log(` ${'ITEM'.padEnd(25)} ${'OLD QTY'.padStart(9)} → ${'NEW QTY'.padStart(9)}  ${'UNIT COST'.padStart(10)}`)
console.log('─'.repeat(70))

let updated = 0, notFound = []

for (const u of UPDATES) {
  const item = allItems.find(i => i.name.toLowerCase() === u.name.toLowerCase())
  if (!item) {
    notFound.push(u.name)
    continue
  }

  const oldQty  = item.quantity
  const oldCost = item.unitCost
  await prisma.inventoryItem.update({
    where: { id: item.id },
    data:  { quantity: u.qty, unitCost: Math.round(u.cost * 100) / 100 }
  })

  const delta = u.qty - oldQty
  const sign  = delta >= 0 ? '+' : ''
  console.log(
    ` ${item.name.padEnd(25)} ${String(oldQty).padStart(9)} → ${String(u.qty).padStart(9)}  ` +
    `${String((Math.round(u.cost*100)/100).toFixed(2)).padStart(9)} RWF  (${sign}${delta})`
  )
  updated++
}

console.log('─'.repeat(70))
console.log(`\n✅ Updated ${updated} items.\n`)

if (notFound.length) {
  console.log(`⚠ These names had no match in DB (check spelling):`)
  for (const n of notFound) console.log(`   • ${n}`)
  console.log()
}

// Show items still at zero (in recipe but not on sheet)
const stillZero = allItems.filter(i =>
  !UPDATES.find(u => u.name.toLowerCase() === i.name.toLowerCase()) && i.quantity === 0
)
if (stillZero.length) {
  console.log(`ℹ Items still at 0 (not on sheet):`)
  for (const i of stillZero) console.log(`   • ${i.name} (${i.unit})`)
}

await prisma.$disconnect()
