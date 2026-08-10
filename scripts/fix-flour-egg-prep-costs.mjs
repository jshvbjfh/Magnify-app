/**
 * Little Taipei / WHATABURGER (2026-07-14): fix the prep-chain unit bugs that
 * made one dumpling plate "cost" 14,204 RWF and report a fake -6,205 loss.
 *  1. LT Flour → grams (4 bags = 8000g @ 1.5/g; batch bought-in-bag ×2000).
 *     Today's bogus 8kg consumption restored: true usage was 40g → stock 7960g.
 *  2. WHATABURGER Onions → grams (same 1000× conversion, no consumption yet).
 *  3. Today's dumpling sale corrected: flour ledger 40g@1.5=60, egg ledger
 *     0.32pc@166.667=53.33 (was 5000/pc), DishSaleIngredient rows to match,
 *     DishSale.calculatedFoodCost recomputed from the corrected lines.
 *  4. Every affected prep item's unitCost recomputed from its sub-recipe.
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

const LT = 'cmqiad2vx000in5p176jvqush'
const FLOUR = 'cmr1z9tm30001ys5p38rypm23'
const FLOUR_BATCH = 'cmrdrqqas000bx3hrpw52ijgl'
const SALE = 'cmrkwzo0r007m108fpq800ura'
const FLOUR_LEDGER = 'cmrkwzo2a007q108fi0tpm4fk'
const EGG_LEDGER = 'cmrkwzo5e0086108fqa0xadbf'
const EGG = 'cmqjl1daw000haltle9gka675'
const EGG_BATCH = 'cmqjz8djw003dba67xjn0zqeq'

await prisma.$transaction(async tx => {
  // 1. Flour → grams. True consumption today: 8 wrappers × 5g = 40g.
  await tx.inventoryItem.update({
    where: { id: FLOUR },
    data: { unit: 'g', quantity: 7960, unitCost: 1.5 },
  })
  await tx.inventoryPurchase.update({
    where: { id: FLOUR_BATCH },
    data: {
      purchaseQuantity: 4, purchaseUnit: 'bag', unitsPerPurchaseUnit: 2000, purchaseUnitCost: 3000,
      quantityPurchased: 8000, remainingQuantity: 7960, unitCost: 1.5, totalCost: 12000,
    },
  })
  console.log('Flour: 8000g @ 1.5/g (4 bags × 2000g @ 3000/bag); 40g consumed today → 7960g on hand')

  // 2. WHATABURGER Onions → grams
  const onions = await tx.inventoryItem.findFirst({
    where: { branchId: 'cmqiaa69u0008n5p1y8v0zkls', name: 'Onions', deletedAt: null },
    select: { id: true, unit: true, quantity: true, unitCost: true },
  })
  if (onions && onions.unit === 'kg') {
    await tx.inventoryItem.update({
      where: { id: onions.id },
      data: { unit: 'g', quantity: onions.quantity * 1000, unitCost: onions.unitCost / 1000 },
    })
    const r = await tx.inventoryPurchase.findMany({ where: { ingredientId: onions.id, deletedAt: null } })
    for (const p of r) {
      await tx.inventoryPurchase.update({
        where: { id: p.id },
        data: {
          purchaseQuantity: p.quantityPurchased, purchaseUnit: 'kg', unitsPerPurchaseUnit: 1000,
          purchaseUnitCost: p.unitCost, quantityPurchased: p.quantityPurchased * 1000,
          remainingQuantity: p.remainingQuantity * 1000, unitCost: p.unitCost / 1000,
        },
      })
    }
    console.log(`Onions (WHATABURGER): ${onions.quantity}kg → ${onions.quantity * 1000}g @ ${onions.unitCost / 1000}/g`)
  } else {
    console.log('Onions (WHATABURGER): already grams or missing — skipped')
  }

  // 3. Correct today's sale consumption
  await tx.inventoryBatchUsageLedger.update({
    where: { id: FLOUR_LEDGER },
    data: { quantityConsumed: 40, unitCost: 1.5, totalCost: 60 },
  })
  await tx.inventoryBatchUsageLedger.update({
    where: { id: EGG_LEDGER },
    data: { unitCost: 166.667, totalCost: 53.333 },
  })
  // DishSaleIngredient rows for the sale
  const saleRows = await tx.dishSaleIngredient.findMany({
    where: { dishSaleId: SALE },
    select: { id: true, ingredientId: true, quantityUsed: true, actualCost: true },
  })
  let newFoodCost = 0
  for (const row of saleRows) {
    let quantityUsed = row.quantityUsed
    let actualCost = row.actualCost
    if (row.ingredientId === FLOUR) { quantityUsed = 40; actualCost = 60 }
    if (row.ingredientId === EGG) { actualCost = 53.333 }
    newFoodCost += actualCost
    if (quantityUsed !== row.quantityUsed || actualCost !== row.actualCost) {
      await tx.dishSaleIngredient.update({ where: { id: row.id }, data: { quantityUsed, actualCost } })
    }
  }
  newFoodCost = Math.round(newFoodCost * 1000) / 1000
  await tx.dishSale.update({ where: { id: SALE }, data: { calculatedFoodCost: newFoodCost } })
  console.log(`Dumpling sale: food cost 14204.633 → ${newFoodCost} (profit today: ${8000 - newFoodCost})`)
  // Egg batch remaining is correct (0.32 consumed); only its cost record was wrong.
  void EGG_BATCH

  // 4. Recompute unitCost for every prep whose sub-recipe we just re-based
  const preps = await tx.inventoryItem.findMany({
    where: { type: 'prep', deletedAt: null, prepIngredients: { some: { ingredient: { id: { in: [FLOUR, ...(onions ? [onions.id] : [])] } } } } },
    select: { id: true, name: true, unitCost: true, prepIngredients: { select: { quantityRequired: true, ingredient: { select: { unitCost: true } } } } },
  })
  for (const prep of preps) {
    const cost = Math.round(prep.prepIngredients.reduce((s, p) => s + p.quantityRequired * p.ingredient.unitCost, 0) * 1000) / 1000
    await tx.inventoryItem.update({ where: { id: prep.id }, data: { unitCost: cost } })
    console.log(`Prep ${prep.name}: unitCost ${prep.unitCost} → ${cost}`)
  }
}, { timeout: 120000, maxWait: 10000 })

await prisma.$disconnect()
console.log('Done.')
