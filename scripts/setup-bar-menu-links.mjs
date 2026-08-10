/**
 * Parking Bar setup:
 *  1. Fix unitCost on InventoryItem + InventoryPurchase records where cost = 0
 *  2. Link Parking Bar dishes to their inventory items (DishIngredient)
 * Run: node scripts/setup-bar-menu-links.mjs --commit
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
const COMMIT = process.argv.includes('--commit')
const EMAIL = 'high5ive@management.com'

// Costs from the stock report image (cost per bottle/shot)
const COST_FIXES = [
  ['Desperado',          2216],
  ['Skol Lager',         895.8],
  ['Skol Malt',          795.8],
  ['Virunga Gold',       895.8],
  ['Virunga Mist',       895.8],
  ['Virunga Silver',     795.8],
  ['Coca Zero (50cl)',    916],
  ['Fanta Orange (small)', 916],
  ['Wow Water',          291.6],
  ['Red Label',          28000],
  ['Red Label (shots)',   1272],
  ['Jack Daniel',        74000],
  ['Jack Daniel (shots)', 3363],
  ['Olmeca Gold',        48000],
  ['Olmeca Gold (shots)', 2181],
  ['Centrachi',          19000],
]

// dish name → inventory item name, qty consumed per sale
const DISH_LINKS = [
  ['Amstel',                'Amstel',               1],
  ['Heineken',              'Heineken',              1],
  ['Mutzig',                'Mutzing',               1],
  ['Skoll Lager',           'Skol Lager',            1],
  ['Skoll Malt',            'Skol Malt',             1],
  ['Desperado',             'Desperado',             1],
  ['Virunga',               'Virunga Silver',        1],  // most common type (51 bottles)
  ['Prosecco',              'Prosecco',              1],
  ['Red Wine (Merlot)',     'Merlot',                1],
  ['White Wine (Sauvignon)','Jardin des C Sauvignon',1],
  ['Coke',                  'Coca Cola',             1],
  ['Sprite',                'Sprite',                1],
  ['Panache',               'Panache',               1],
  ['Water',                 'Wow Water',             1],
]

async function main() {
  console.log(`\n${COMMIT ? '🟢 COMMIT' : '🟡 DRY RUN'} — Parking Bar setup\n`)

  const user = await prisma.user.findUnique({ where: { email: EMAIL }, select: { id: true } })
  const rest = await prisma.restaurant.findFirst({ where: { ownerId: user.id }, select: { id: true } })
  const branch = await prisma.branch.findFirst({
    where: { restaurantId: rest.id, name: 'Parking Bar' },
    select: { id: true, name: true },
  })
  if (!branch) { console.log('Parking Bar branch not found'); return }
  console.log(`Branch: ${branch.name} (${branch.id})\n`)

  // ── 1. Fix inventory item costs ──────────────────────────────────────────
  console.log('── STEP 1: Fix zero-cost inventory items ─────────────────────')
  for (const [name, newCost] of COST_FIXES) {
    const item = await prisma.inventoryItem.findFirst({
      where: { branchId: branch.id, name },
      select: { id: true, name: true, unitCost: true },
    })
    if (!item) { console.log(`  ⚠ not found: "${name}"`); continue }

    const oldCost = item.unitCost ?? 0
    if (Math.abs(oldCost - newCost) < 0.01) {
      console.log(`  = ${name}  ${newCost} RWF (already correct)`)
      continue
    }

    console.log(`  ${COMMIT ? '→' : '[DRY]'} ${name}  ${oldCost} → ${newCost} RWF`)
    if (COMMIT) {
      await prisma.inventoryItem.update({ where: { id: item.id }, data: { unitCost: newCost } })

      // Also update purchase records for this item so FIFO is consistent
      const purchases = await prisma.inventoryPurchase.findMany({
        where: { ingredientId: item.id, branchId: branch.id },
        select: { id: true, unitCost: true, quantityPurchased: true },
      })
      for (const p of purchases) {
        if ((p.unitCost ?? 0) < 0.01) {
          const newTotal = p.quantityPurchased * newCost
          await prisma.inventoryPurchase.update({
            where: { id: p.id },
            data: { unitCost: newCost, totalCost: newTotal },
          })
          console.log(`    purchase ${p.id.slice(-6)}: unitCost → ${newCost}, totalCost → ${newTotal.toFixed(2)}`)
        }
      }
    }
  }

  // ── 2. Link dishes to inventory items ────────────────────────────────────
  console.log('\n── STEP 2: Link dishes to inventory items ────────────────────')
  let linked = 0, skipped = 0, missing = 0
  for (const [dishName, itemName, qty] of DISH_LINKS) {
    const dish = await prisma.dish.findFirst({
      where: { branchId: branch.id, name: dishName, deletedAt: null },
      select: { id: true, name: true },
    })
    const item = await prisma.inventoryItem.findFirst({
      where: { branchId: branch.id, name: itemName },
      select: { id: true, name: true, unit: true, unitCost: true },
    })

    if (!dish) { console.log(`  ⚠ dish not found: "${dishName}"`); missing++; continue }
    if (!item) { console.log(`  ⚠ inventory item not found: "${itemName}"`); missing++; continue }

    const existing = await prisma.dishIngredient.findFirst({
      where: { dishId: dish.id, inventoryItemId: item.id },
    })
    if (existing) {
      console.log(`  = ${dishName} → ${item.name} (${qty}${item.unit}) already linked`)
      skipped++
      continue
    }

    console.log(`  ${COMMIT ? '→' : '[DRY]'} ${dishName} → ${item.name}  ${qty} ${item.unit}  @ ${item.unitCost ?? 0} RWF/${item.unit}`)
    if (COMMIT) {
      await prisma.dishIngredient.create({
        data: { dishId: dish.id, inventoryItemId: item.id, quantityRequired: qty },
      })
    }
    linked++
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n── SUMMARY ───────────────────────────────────────────────────`)
  console.log(`  Cost fixes   : ${COST_FIXES.length} items processed`)
  console.log(`  Links added  : ${linked}`)
  console.log(`  Already done : ${skipped}`)
  console.log(`  Not found    : ${missing}`)

  console.log(`\n── SKIPPED (no inventory item — need manual setup) ───────────`)
  const noItem = ['Fanta (ambiguous — Fanta Orange/Citron/Fiesta?)', 'Tonic (no inventory item)', 'Fresh Juice (no inventory item)', 'Wine by the glass (ambiguous — Angelo/Palo Alto/Merlot?)', 'Hot Beverages (no inventory items)', 'Mocktails (no inventory items)', 'Smoothies & Shakes (no inventory items)']
  for (const n of noItem) console.log(`  ⚠ ${n}`)

  if (!COMMIT) console.log('\nRe-run with --commit to apply.')
}

main().catch(e => { console.error('FATAL:', e.message) }).finally(() => prisma.$disconnect())
