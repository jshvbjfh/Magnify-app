/**
 * Create inventory items + first batch purchase for Parking Bar and Banana Bar.
 * DRY RUN by default. Pass --commit to write.
 */
import { createRequire } from 'module'; import { resolve } from 'path'; import { readFileSync } from 'fs'
for (const f of ['.env.local','.env']) { try { for (const l of readFileSync(resolve(process.cwd(),f),'utf8').split('\n')) { const t=l.trim(); if(!t||t.startsWith('#'))continue; const e=t.indexOf('='); if(e<0)continue; const k=t.slice(0,e).trim(), v=t.slice(e+1).trim().replace(/^['"]|['"]$/g,''); if(!process.env[k])process.env[k]=v } } catch{} }
const require = createRequire(import.meta.url)
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })
const COMMIT = process.argv.includes('--commit')

// [name, unit, qty, unitCost, category]
// unitCost = cost per unit (cost per bottle, per shot, per glass, per ml)
// qty = closing stock quantity
const PARKING_BAR = [
  // BEERS
  ['Amstel',                'bottle', 62,  937.5,   'Beer'],
  ['Mutzing',               'bottle', 65,  812.5,   'Beer'],
  ['Heineken',              'bottle', 21,  1104,    'Beer'],
  ['Desperado',             'bottle', 20,  0,       'Beer'],
  ['Skol Lager',            'bottle', 22,  0,       'Beer'],
  ['Skol Malt',             'bottle', 67,  0,       'Beer'],
  ['Virunga Silver',        'bottle', 51,  0,       'Beer'],
  ['Virunga Mist',          'bottle', 19,  0,       'Beer'],
  ['Virunga Gold',          'bottle', 50,  0,       'Beer'],
  // SOFT DRINKS
  ['Fanta Orange',          'bottle', 40,  520,     'Soft Drinks'],
  ['Fanta Citron',          'bottle', 66,  520,     'Soft Drinks'],
  ['Fanta Fiesta',          'bottle', 61,  520,     'Soft Drinks'],
  ['Coca Cola',             'bottle', 63,  520,     'Soft Drinks'],
  ['Coca Zero (50cl)',       'bottle', 16,  0,       'Soft Drinks'],
  ['Coca Zero (30cl)',       'bottle', 14,  520,     'Soft Drinks'],
  ['Panache',               'bottle', 55,  562.5,   'Soft Drinks'],
  ['Sparkling Water Virunga','bottle', 0,   0,       'Soft Drinks'],
  ['Sparkling Water Vitalo','bottle', 16,  0,       'Soft Drinks'],
  ['Sprite',                'bottle', 27,  520,     'Soft Drinks'],
  ['Wow Water',             'bottle', 241, 0,       'Soft Drinks'],
  ['Fanta Orange (small)',   'bottle', 16,  291.6,   'Soft Drinks'],
  // WHISKY
  ['Red Label',             'bottle', 0,   0,       'Whisky'],
  ['Red Label (shots)',      'shots',  16,  0,       'Whisky'],
  ['Jack Daniel',           'bottle', 1,   0,       'Whisky'],
  ['Jack Daniel (shots)',    'shots',  20,  0,       'Whisky'],
  // VODKA
  ['Absolute Vodka (shots)', 'shots',  17,  35000,   'Vodka'],
  // GIN
  ['Camino',                'bottle', 0,   35000,   'Gin'],
  ['Camino (shots)',         'shots',  10,  2187.5,  'Gin'],
  ['Olmeca Silver',         'bottle', 1,   50000,   'Gin'],
  ['Olmeca Silver (shots)',  'shots',  22,  1100,    'Gin'],
  ['Olmeca Gold',           'bottle', 1,   0,       'Gin'],
  ['Olmeca Gold (shots)',    'shots',  22,  0,       'Gin'],
  // LIQUOR
  ['Jagermeister',          'bottle', 1,   45000,   'Liquor'],
  ['Jagermeister (shots)',   'shots',  22,  2045,    'Liquor'],
  ['Bacardi',               'bottle', 0,   34000,   'Liquor'],
  ['Martini Rosso',         'bottle', 1,   1545,    'Liquor'],
  ['Cointreau',             'bottle', 1,   65000,   'Liquor'],
  ['Triple Sec',            'bottle', 1,   25000,   'Liquor'],
  // SPARKLING WINE
  ['Centrachi',             'bottle', 11,  0,       'Sparkling Wine'],
  ['Prosecco',              'bottle', 3,   26000,   'Sparkling Wine'],
  // WHITE WINE
  ['Bacada',                'glass',  0,   0,       'White Wine'],
  ['Jardin des C Sauvignon','glass',  54,  18000,   'White Wine'],
  // RED WINE
  ['Angelo',                'glass',  0,   12000,   'Red Wine'],
  ['Palo Alto',             'glass',  35,  12000,   'Red Wine'],
  ['Merlot',                'bottle', 11,  18000,   'Red Wine'],
]

const BANANA_BAR = [
  ['Bacardi',       'ml',    0,    0, 'Spirits'],
  ['Captain Morgan','ml',    925,  0, 'Spirits'],
  ['Campari',       'ml',    820,  0, 'Spirits'],
  ['Jameson',       'shots', 22,   0, 'Spirits'],
  ['Gin Gordon',    'ml',    1370, 0, 'Spirits'],
  ['Tequila Camino','shots', 12,   0, 'Spirits'],
  ['Cointreau',     'shots', 22,   0, 'Spirits'],
  ['Triple Sec',    'ml',    1120, 0, 'Spirits'],
  ['Martini Rosso', 'ml',    720,  0, 'Spirits'],
  ['Jack Daniel',   'shots', 22,   0, 'Spirits'],
  ['Olmeca Gold',   'ml',    1425, 0, 'Spirits'],
  ['Blue Curacao',  'shots', 16,   0, 'Spirits'],
  ['Olmeca Silver', 'ml',    1310, 0, 'Spirits'],
]

async function loadBranch(rest, branchName, items, batchId) {
  const branch = await prisma.branch.findFirst({ where:{ restaurantId:rest.id, name:branchName }, select:{ id:true, name:true } })
  if (!branch) { console.log(`\n⚠ Branch "${branchName}" not found — skip`); return }
  console.log(`\n=== ${branch.name} (batch ${batchId}) ===`)
  let created = 0, skipped = 0
  for (const [name, unit, qty, unitCost, category] of items) {
    const exists = await prisma.inventoryItem.findFirst({ where:{ branchId:branch.id, name, deletedAt:null }, select:{ id:true } })
    if (exists) { console.log(`  = exists: ${name}`); skipped++; continue }
    const totalCost = qty * unitCost
    console.log(`  + ${name} [${unit}] qty=${qty} unitCost=${unitCost} total=${totalCost.toFixed(0)}`)
    created++
    if (COMMIT) {
      const item = await prisma.inventoryItem.create({ data:{ restaurantId:rest.id, branchId:branch.id, name, unit, quantity:qty, unitCost, category } })
      await prisma.inventoryPurchase.create({ data:{ restaurantId:rest.id, branchId:branch.id, ingredientId:item.id, quantityPurchased:qty, remainingQuantity:qty, unitCost, totalCost, batchId } })
    }
  }
  console.log(`  → ${created} to create, ${skipped} already exist`)
}

async function main() {
  console.log(`\n${COMMIT ? '🟢 COMMIT' : '🟡 DRY RUN'} — load Parking Bar + Banana Bar stock\n`)
  const user = await prisma.user.findUnique({ where:{ email:'high5ive@management.com' }, select:{ id:true } })
  const rest = await prisma.restaurant.findFirst({ where:{ ownerId:user.id }, select:{ id:true } })
  await loadBranch(rest, 'Parking Bar', PARKING_BAR, 'B-06272026-PARKBAR')
  await loadBranch(rest, 'Banana Bar',  BANANA_BAR,  'B-06272026-BANABAR')
  console.log(`\n${COMMIT ? 'Committed.' : 'Dry run — re-run with --commit to apply.'}\n`)
}
main().catch(e => console.error('FATAL:', e.message)).finally(() => prisma.$disconnect())
