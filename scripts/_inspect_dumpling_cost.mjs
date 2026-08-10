/** READ-ONLY: Signature Dumplings (Pan-fried) recipe with per-line cost, plus
 *  the recorded sale-ingredient breakdown from today's 17:17 sale. */
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

const dish = await prisma.dish.findFirst({
  where: { branchId: LT, name: 'Signature Dumplings (Pan-fried)', deletedAt: null },
  select: {
    id: true, sellingPrice: true,
    ingredients: { select: { quantityRequired: true, unit: true, inventoryItem: { select: { id: true, name: true, unit: true, unitCost: true, quantity: true, type: true } } } },
  },
})
console.log(`Signature Dumplings (Pan-fried) @ ${dish.sellingPrice}`)
let total = 0
for (const i of dish.ingredients) {
  const line = i.quantityRequired * (i.inventoryItem.unitCost ?? 0)
  total += line
  console.log(`  ${i.inventoryItem.name}: ${i.quantityRequired}${i.unit ?? i.inventoryItem.unit} × ${i.inventoryItem.unitCost}/${i.inventoryItem.unit} = ${line}  (stock ${i.inventoryItem.quantity}${i.inventoryItem.unit}, ${i.inventoryItem.type})`)
}
console.log(`  → naive recipe cost: ${total}`)

// The actual recorded consumption for today's sale
const sale = await prisma.dishSale.findFirst({
  where: { branchId: LT, dishName: 'Signature Dumplings (Pan-fried)', saleDate: { gte: new Date('2026-07-14T00:00:00Z') } },
  select: { id: true, calculatedFoodCost: true },
})
if (sale) {
  const rows = await prisma.dishSaleIngredient.findMany({
    where: { dishSaleId: sale.id },
    select: { quantityUsed: true, actualCost: true, ingredient: { select: { name: true, unit: true, type: true } } },
  })
  console.log(`\nRecorded consumption for today's sale (total ${sale.calculatedFoodCost}):`)
  for (const r of rows) {
    console.log(`  ${r.ingredient.name} (${r.ingredient.type}): ${r.quantityUsed}${r.ingredient.unit} → cost ${r.actualCost}`)
  }
}

// Prep sub-recipe for Dumpling wrappers — the cascade path when prep stock is 0
const wrapper = await prisma.inventoryItem.findFirst({
  where: { branchId: LT, name: 'Dumpling wrappers', deletedAt: null },
  select: {
    id: true, unit: true, quantity: true, unitCost: true, type: true,
    prepIngredients: { select: { quantityRequired: true, ingredient: { select: { name: true, unit: true, unitCost: true, quantity: true } } } },
  },
})
console.log(`\nDumpling wrappers prep: ${wrapper.quantity}${wrapper.unit} @ ${wrapper.unitCost} (${wrapper.type})`)
for (const p of wrapper.prepIngredients) {
  console.log(`  per 1 ${wrapper.unit}: ${p.ingredient.name} ${p.quantityRequired}${p.ingredient.unit} × ${p.ingredient.unitCost}/${p.ingredient.unit} = ${p.quantityRequired * p.ingredient.unitCost}`)
}

await prisma.$disconnect()
