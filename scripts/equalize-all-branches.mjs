/**
 * Equalize "Qty bought" / "Cost/unit" / "Tot. stock value" to match the real
 * "Stock on hand" (InventoryItem.quantity/unitCost) across EVERY branch of
 * High 5ive, wherever an existing InventoryPurchase row still shows 0.
 * Only UPDATEs existing purchase rows — never creates new ones (items with
 * zero purchase rows at all are left alone and reported separately).
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

async function main() {
  console.log(`\n${COMMIT ? '🟢 COMMIT' : '🟡 DRY RUN'} — equalize Qty bought to Stock on hand, all branches\n`)

  const rest = await prisma.restaurant.findFirst({ where: { name: { contains: 'High 5', mode: 'insensitive' } }, select: { id: true } })
  const branches = await prisma.branch.findMany({ where: { restaurantId: rest.id }, select: { id: true, name: true } })

  let updated = 0, skippedNoRealStock = 0, skippedNoRow = 0

  for (const b of branches) {
    const items = await prisma.inventoryItem.findMany({ where: { branchId: b.id, deletedAt: null }, select: { id: true, name: true, unit: true, quantity: true, unitCost: true } })
    const purchases = await prisma.inventoryPurchase.findMany({ where: { branchId: b.id, deletedAt: null, quantityPurchased: 0 }, select: { id: true, ingredientId: true, quantityPurchased: true, remainingQuantity: true, unitCost: true } })
    if (purchases.length === 0) continue
    console.log(`=== ${b.name} ===`)

    for (const p of purchases) {
      const item = items.find(i => i.id === p.ingredientId)
      if (!item) continue
      if (item.quantity === 0) { skippedNoRealStock++; console.log(`  = ${item.name}: real stock is also 0 — nothing to equalize to, leave as-is`); continue }

      const totalCost = Math.round(item.quantity * item.unitCost * 100) / 100
      console.log(`  ~ ${item.name}: Qty bought 0 -> ${item.quantity} ${item.unit}, Cost/unit 0 -> ${item.unitCost}, Tot. value -> ${totalCost}`)
      updated++
      if (COMMIT) {
        await prisma.inventoryPurchase.update({
          where: { id: p.id },
          data: {
            quantityPurchased: item.quantity,
            remainingQuantity: item.quantity,
            unitCost: item.unitCost,
            totalCost,
            purchaseQuantity: item.quantity,
            purchaseUnit: item.unit,
            purchaseUnitCost: item.unitCost,
            unitsPerPurchaseUnit: 1,
          },
        })
      }
    }
  }

  // Report items with real stock but NO purchase row at all (can't fix by update — would need a new row)
  console.log(`\n=== Items with real stock but NO purchase row at all (not touched) ===`)
  for (const b of branches) {
    const items = await prisma.inventoryItem.findMany({ where: { branchId: b.id, deletedAt: null, quantity: { gt: 0 } }, select: { id: true, name: true, quantity: true, unit: true } })
    for (const item of items) {
      const count = await prisma.inventoryPurchase.count({ where: { ingredientId: item.id, deletedAt: null } })
      if (count === 0) { skippedNoRow++; console.log(`  ${b.name} / ${item.name}: ${item.quantity}${item.unit}, no purchase row exists`) }
    }
  }

  console.log(`\nEqualized: ${updated}. Already-zero (nothing to sync): ${skippedNoRealStock}. No purchase row at all (needs a new row, not touched): ${skippedNoRow}.`)
  console.log(`${COMMIT ? 'Committed.' : 'Dry run — re-run with --commit to apply.'}\n`)
}
main().catch(e => console.error('FATAL:', e.message)).finally(() => prisma.$disconnect())
