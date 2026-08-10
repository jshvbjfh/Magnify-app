/** READ-ONLY: Little Taipei Flour + Egg items/batches, and every prep
 *  sub-recipe line that references bulk-unit (kg/ltr) raw items. */
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

const REST = 'cmqia7buf0003n5p19gkoov3k'
const LT = 'cmqiad2vx000in5p176jvqush'

for (const name of ['Flour', 'Egg']) {
  const items = await prisma.inventoryItem.findMany({
    where: { branchId: LT, name: { contains: name }, deletedAt: null },
    select: {
      id: true, name: true, unit: true, quantity: true, unitCost: true, type: true,
      purchases: { where: { deletedAt: null }, select: { id: true, batchId: true, purchaseQuantity: true, purchaseUnit: true, unitsPerPurchaseUnit: true, purchaseUnitCost: true, quantityPurchased: true, remainingQuantity: true, unitCost: true, totalCost: true } },
    },
  })
  for (const it of items) {
    console.log(`\n${it.name} [${it.id}]: ${it.quantity}${it.unit} @ ${it.unitCost}/${it.unit} (${it.type})`)
    for (const p of it.purchases) console.log(`  batch ${p.batchId ?? 'NO-ID'} [${p.id}]: bought ${p.purchaseQuantity}${p.purchaseUnit ?? it.unit}(=${p.quantityPurchased}${it.unit}) remaining ${p.remainingQuantity} @ ${p.unitCost} total ${p.totalCost}`)
  }
}

// All prep sub-recipe lines across the restaurant referencing kg/ltr items
const risky = await prisma.prepIngredient.findMany({
  where: { ingredient: { restaurantId: REST, unit: { in: ['kg', 'Kg', 'ltr', 'Ltr', 'l', 'L'] } } },
  select: {
    quantityRequired: true,
    prepItem: { select: { name: true, unit: true, branch: { select: { name: true } } } },
    ingredient: { select: { name: true, unit: true, unitCost: true } },
  },
})
console.log(`\n=== Prep lines using kg/ltr raw items (${risky.length}) ===`)
for (const r of risky) {
  console.log(`  ${r.prepItem.branch.name} | 1 ${r.prepItem.unit} ${r.prepItem.name} uses ${r.quantityRequired}${r.ingredient.unit} ${r.ingredient.name} (= ${r.quantityRequired * r.ingredient.unitCost} RWF)`)
}

// Today's flour/egg usage ledgers for the dumpling sale
const ledgers = await prisma.inventoryBatchUsageLedger.findMany({
  where: { branchId: LT, consumedAt: { gte: new Date('2026-07-14T00:00:00Z') } },
  select: { id: true, quantityConsumed: true, unitCost: true, totalCost: true, sourceType: true, sourceId: true, purchaseId: true, ingredient: { select: { name: true, unit: true } } },
})
console.log(`\n=== Today's LT consumption ledgers (${ledgers.length}) ===`)
for (const l of ledgers) console.log(`  [${l.id}] ${l.ingredient.name}: ${l.quantityConsumed}${l.ingredient.unit} @ ${l.unitCost} = ${l.totalCost} (${l.sourceType} ${l.sourceId})`)

await prisma.$disconnect()
