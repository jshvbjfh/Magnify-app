/**
 * Little Taipei — phase 2 stock update.
 * Handles: Beef split, Tofu (pcs + recipe fix), Cabbage, Chili paste, Chicken broth.
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
const rest = await prisma.restaurant.findFirst({ where: { ownerId: user.id }, select: { id: true } })
const branch = await prisma.branch.findFirst({
  where: { restaurantId: rest.id, name: { contains: 'Taipei', mode: 'insensitive' } },
  select: { id: true, name: true }
})
console.log(`\nBranch: ${branch.name}\n`)

const items = await prisma.inventoryItem.findMany({
  where: { branchId: branch.id, deletedAt: null },
  select: { id: true, name: true, unit: true, quantity: true }
})
const get = (n) => items.find(i => i.name.toLowerCase() === n.toLowerCase())

// ── 1. Beef — 9 KG total split 50/50 between the two recipe items ──────────
// The kitchen has one pool of beef; recipes need "braised chunks" and "strips" separately.
// Split 4,500g each. Adjust if the kitchen allocates differently.
const beefBraised = get('Beef (braised chunks)')
const beefStrips  = get('Beef (strips)')
if (beefBraised) {
  await prisma.inventoryItem.update({ where: { id: beefBraised.id }, data: { quantity: 4500, unitCost: 8.5 } })
  console.log(`✓ Beef (braised chunks): 0 → 4500g  @8.5 RWF/g`)
} else console.log('✗ Beef (braised chunks) not found')

if (beefStrips) {
  await prisma.inventoryItem.update({ where: { id: beefStrips.id }, data: { quantity: 4500, unitCost: 8.5 } })
  console.log(`✓ Beef (strips):         0 → 4500g  @8.5 RWF/g`)
} else console.log('✗ Beef (strips) not found')

// ── 2. Silken tofu — change unit to pcs, update recipe ingredient ──────────
const tofu = get('Silken tofu')
if (tofu) {
  // Update the inventory item unit and quantity
  await prisma.inventoryItem.update({
    where: { id: tofu.id },
    data: { unit: 'pcs', quantity: 14, unitCost: 2000 }
  })
  console.log(`✓ Silken tofu: unit g → pcs, qty 0 → 14 pcs  @2000 RWF/pcs`)

  // Update all recipe ingredients that link to this item: 200g → 1 pcs
  const updated = await prisma.dishIngredient.updateMany({
    where: { inventoryItemId: tofu.id },
    data: { quantityRequired: 1, unit: 'pcs' }
  })
  console.log(`  → Updated ${updated.count} recipe ingredient(s): 200g → 1 pcs`)
} else console.log('✗ Silken tofu not found')

// ── 3. Cabbage (napa) — 3 heads × 1,300g = 3,900g ────────────────────────
const cabbage = get('Cabbage (napa)')
if (cabbage) {
  await prisma.inventoryItem.update({ where: { id: cabbage.id }, data: { quantity: 3900, unitCost: 700 / 1300 } })
  console.log(`✓ Cabbage (napa): 0 → 3900g  (3 heads × ~1,300g)  @0.54 RWF/g`)
} else console.log('✗ Cabbage (napa) not found')

// ── 4. Chili paste — red chili 3 KG mapped as chili paste ─────────────────
const chiliPaste = get('Chili paste')
if (chiliPaste) {
  await prisma.inventoryItem.update({ where: { id: chiliPaste.id }, data: { quantity: 3000, unitCost: 3500 / 1000 } })
  console.log(`✓ Chili paste: 0 → 3000g  (red chili 3 KG)  @3.5 RWF/g`)
} else console.log('✗ Chili paste not found')

// ── 5. Chicken broth — chicken powder 1.8 KG mapped as broth equivalent ───
// 1800g chicken powder entered as 1800ml broth-equivalent (concentrated stock).
// Recipes use 80ml (Dan Dan) / 100ml (Mapo Tofu) per dish — will need dilution in practice.
const chickenBroth = get('Chicken broth')
if (chickenBroth) {
  await prisma.inventoryItem.update({ where: { id: chickenBroth.id }, data: { quantity: 1800, unitCost: 18000 / 1800 } })
  console.log(`✓ Chicken broth: 0 → 1800ml  (chicken powder 1.8kg → 1800ml equiv)  @10 RWF/ml`)
} else console.log('✗ Chicken broth not found')

// ── Summary ────────────────────────────────────────────────────────────────
console.log('\n─'.repeat(60))
const zero = await prisma.inventoryItem.findMany({
  where: { branchId: branch.id, deletedAt: null, quantity: 0 },
  select: { name: true, unit: true }
})
console.log(`\nℹ ${zero.length} items still at 0 after both phases:`)
for (const i of zero) console.log(`   • ${i.name} (${i.unit})`)

await prisma.$disconnect()
