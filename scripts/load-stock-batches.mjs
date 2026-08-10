/**
 * Load High 5ive stock into existing (empty) FIFO batches.
 * Rule: only rows that are a clean same-substance match to an existing system
 * item AND unit-convertible (KG→g, Gramme→g, or same unit) AND have both qty +
 * cost are loaded. Everything else is LEFT OUT and FLAGGED with a reason.
 * COST column is treated as the TOTAL for the stock line (not per-unit).
 *
 * DRY RUN by default. Pass --commit to write.
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

// Sheet rows per branch: [item, unit, stockIn|null, cost|null]
const SHEET = {
  'Tiamo Pasta': [
    ['Salt','PCS',2,700],['Parsley','Bunch',null,700],['Parmesan','PCS',1,32000],['Bay leaves','PCS',1,null],
    ['Nutmeg','PCS',null,6200],['Rosemary','PCS',1,700],['white pepper','PCS',1,null],['Oregano','PCS',2,null],
    ['Garlic','PCS',1,null],['Chicken Masala','PCS',2,3600],['Chilli Flakes','PCS',1,null],['Thyme','PCS',1,null],
    ['Olive Oil','Bottle',1,1200],['Fresh Cream','Bottle',2,17000],['Cheddar Cheese','Gramme',900,1000],
    ['Butters','PCS',1,null],['Minced Meat','KG',3,25500],['Chicken Breast','KG',1,8000],['Maccaroni','PCS',4,11200],
    ['Spaghetti','PCS',3,4200],['Tomatoes','KG',1,2200],['Onions','KG',2,2000],['Basil','KG',1,1250],
  ],
  'Little Taipei': [
    ['Pork','PCS',65,null],['Beef','PCS',180,null],['Chicken','PCS',20,null],['Veg','PCS',70,null],
    ['Beef bones','KG',3,9000],['Beef','Portion',9,8500],['Tofu','Portion',14,2000],['Chicken','Portion',null,null],
    ['Green pepper','KG',2,1500],['Onions','KG',4,4000],['Garlic','KG',1,2000],['Green beans','KG',1,1000],
    ['Coriander','Bunch',1,500],['Tomatoes','KG',2,2200],['Noodle','Portion',10,800],
  ],
  'THE GRILL': [
    ['Mustard','PCS',2,14800],['Bbq sauce','PCS',1,9000],['Beef masala','PCS',1,3600],['Mizuzu','Portion',2,1500],
    ['Skewer','PCS',5,null],['Beef','Portion',5,9500],['Chicken','Portion',12,8000],['Chicken wings','Portion',2,6000],
    ['Tomato paste','PCS',1,3800],
  ],
  'WHATABURGER': [
    ['Buns','PCS',10,10000],['Beef','Portion',50,8500],['Chicken','Portion',49,800],['Pickles','bottles',1,5700],
    ['Onions','KG',1,1500],['Tomatoes','KG',1,1100],['Mustard','PCS',1,6300],
  ],
}

// Safe maps: sheetItem@branch -> { sys: systemItemName, conv: 'kg_to_g'|'gramme_to_g'|'same' }
const SAFE = {
  'Tiamo Pasta': {
    'Minced Meat':  { sys: 'Ground beef',     conv: 'kg_to_g' },
    'Chicken Breast': { sys: 'Chicken breast', conv: 'kg_to_g' },
    'Onions':       { sys: 'Onion',           conv: 'kg_to_g' },
    'Basil':        { sys: 'Fresh basil',     conv: 'kg_to_g' },
    'Cheddar Cheese': { sys: 'Cheddar / gouda', conv: 'gramme_to_g' },
  },
  'Little Taipei': {
    'Garlic': { sys: 'Garlic (minced)', conv: 'kg_to_g' },
  },
  'THE GRILL': {},
  'WHATABURGER': {
    'Buns': { sys: 'Brioche bun', conv: 'same' },
  },
}

function convert(qty, conv) {
  if (conv === 'kg_to_g') return qty * 1000
  return qty // gramme_to_g or same
}

async function main() {
  console.log(`\n${COMMIT ? '🟢 COMMIT' : '🟡 DRY RUN'} — load stock into batches (COST = line total)\n`)
  const user = await prisma.user.findUnique({ where: { email: 'high5ive@management.com' }, select: { id: true } })
  const rest = await prisma.restaurant.findFirst({ where: { ownerId: user.id }, select: { id: true } })
  const branches = await prisma.branch.findMany({ where: { restaurantId: rest.id }, select: { id: true, name: true } })
  const flagged = []
  let loaded = 0

  for (const [branchName, rows] of Object.entries(SHEET)) {
    const branch = branches.find(b => b.name === branchName)
    if (!branch) { console.log(`(branch not found: ${branchName})`); continue }
    const safe = SAFE[branchName] ?? {}
    console.log(`\n=== ${branchName} ===`)
    for (const [item, unit, qty, cost] of rows) {
      const map = safe[item]
      if (!map) { flagged.push([branchName, item, `${unit} ${qty ?? '-'}/${cost ?? '-'}`, 'no clean same-substance + convertible match']); continue }
      if (qty == null || cost == null) { flagged.push([branchName, item, `${unit}`, `missing ${qty == null ? 'quantity' : 'cost'}`]); continue }
      const sysItem = await prisma.inventoryItem.findFirst({ where: { branchId: branch.id, name: map.sys, deletedAt: null }, select: { id: true, name: true, unit: true, purchases: { where: { deletedAt: null }, select: { id: true }, orderBy: { purchasedAt: 'asc' }, take: 1 } } })
      if (!sysItem) { flagged.push([branchName, item, `${unit}`, `target item "${map.sys}" not found`]); continue }
      const baseQty = convert(qty, map.conv)
      const unitCost = cost / baseQty
      console.log(`  + ${item} (${unit} ${qty}) -> ${sysItem.name}: ${baseQty} ${sysItem.unit} @ ${unitCost.toFixed(3)}/${sysItem.unit}  total=${cost}`)
      loaded++
      if (COMMIT) {
        const batchId = sysItem.purchases[0]?.id
        if (batchId) {
          await prisma.inventoryPurchase.update({ where: { id: batchId }, data: { quantityPurchased: baseQty, remainingQuantity: baseQty, unitCost, totalCost: cost, purchasedAt: new Date() } })
        } else {
          await prisma.inventoryPurchase.create({ data: { restaurantId: rest.id, branchId: branch.id, ingredientId: sysItem.id, quantityPurchased: baseQty, remainingQuantity: baseQty, unitCost, totalCost: cost } })
        }
        await prisma.inventoryItem.update({ where: { id: sysItem.id }, data: { quantity: baseQty, unitCost } })
      }
    }
  }

  console.log(`\n=== FLAGGED / LEFT OUT (${flagged.length}) ===`)
  for (const [b, item, info, reason] of flagged) console.log(`  ⚠ [${b}] ${item} (${info}) — ${reason}`)
  console.log(`\nLoaded: ${loaded} item(s).  ${COMMIT ? 'Committed.' : 'Dry run — re-run with --commit to apply.'}\n`)
}
main().catch(e => console.error('FATAL:', e.message)).finally(() => prisma.$disconnect())
