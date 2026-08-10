/**
 * Tiamo Pasta (2026-07-14): convert the last three kg-tracked recipe items to
 * grams (same kg/g mismatch as Salt/Bell pepper — recipes dose grams but sales
 * consumed kilograms). Purchase rows become bought-in-kg / used-in-g; stock is
 * restored to the full purchased amount in grams; recipe lines marked grams.
 * Prints before/after for each item. Total money values stay unchanged.
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

const TIAMO = 'cmqiadl7h000nn5p1trr8hdcc'
const NAMES = ['Cheddar / gouda', 'Chicken breast', 'Onion']

await prisma.$transaction(async tx => {
  for (const name of NAMES) {
    const item = await tx.inventoryItem.findFirst({
      where: { branchId: TIAMO, name, deletedAt: null },
      select: { id: true, unit: true, quantity: true, unitCost: true,
        purchases: { where: { deletedAt: null }, select: { id: true, quantityPurchased: true, remainingQuantity: true, unitCost: true, totalCost: true } } },
    })
    if (!item) throw new Error(`Not found: ${name}`)
    if (item.unit === 'g') { console.log(`${name}: already grams — skipped`); continue }

    let totalGrams = 0
    for (const p of item.purchases) {
      const grams = p.quantityPurchased * 1000
      totalGrams += grams
      await tx.inventoryPurchase.update({
        where: { id: p.id },
        data: {
          purchaseQuantity: p.quantityPurchased,
          purchaseUnit: 'kg',
          unitsPerPurchaseUnit: 1000,
          purchaseUnitCost: p.unitCost,
          quantityPurchased: grams,
          remainingQuantity: grams,
          unitCost: p.unitCost / 1000,
          // totalCost unchanged: kg × per-kg == g × per-g
        },
      })
    }
    await tx.inventoryItem.update({
      where: { id: item.id },
      data: { unit: 'g', quantity: totalGrams, unitCost: item.unitCost / 1000 },
    })
    const lines = await tx.dishIngredient.updateMany({
      where: { inventoryItemId: item.id },
      data: { unit: 'g' },
    })
    console.log(`${name}: ${item.quantity}${item.unit} @ ${item.unitCost}/kg → ${totalGrams}g @ ${item.unitCost / 1000}/g (${item.purchases.length} batch(es), ${lines.count} recipe lines → g)`)
  }
}, { timeout: 60000, maxWait: 10000 })

await prisma.$disconnect()
console.log('Done.')
