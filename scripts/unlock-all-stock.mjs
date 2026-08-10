/**
 * Make every ingredient's stock row editable/deletable across all of High
 * 5ive, by eliminating item-vs-FIFO-layer drift everywhere:
 *   Part 1 — any ingredient with an existing purchase row whose total layer
 *            quantity doesn't match the real InventoryItem.quantity: correct
 *            the largest row to hold the full real amount, zero out any
 *            other duplicate rows for the same ingredient (no new rows).
 *   Part 2 — any ingredient with real stock but ZERO purchase rows: create
 *            one row using its existing (already-correct) item-level
 *            quantity/cost, so it appears on the batch page at all.
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
  console.log(`\n${COMMIT ? '🟢 COMMIT' : '🟡 DRY RUN'} — unlock every stock row (fix all drift + fill missing rows)\n`)

  const rest = await prisma.restaurant.findFirst({ where: { name: { contains: 'High 5', mode: 'insensitive' } }, select: { id: true } })
  const branches = await prisma.branch.findMany({ where: { restaurantId: rest.id }, select: { id: true, name: true, restaurantId: true } })

  let fixedDrift = 0, createdRows = 0, leftGenuinelyZero = 0

  for (const b of branches) {
    const items = await prisma.inventoryItem.findMany({ where: { branchId: b.id, deletedAt: null }, select: { id: true, name: true, unit: true, quantity: true, unitCost: true } })
    console.log(`=== ${b.name} ===`)

    for (const item of items) {
      const rows = await prisma.inventoryPurchase.findMany({ where: { ingredientId: item.id, deletedAt: null }, orderBy: { remainingQuantity: 'desc' } })
      const layerSum = rows.reduce((s, r) => s + r.remainingQuantity, 0)
      const drift = Math.abs(layerSum - item.quantity) > 0.01

      if (rows.length === 0) {
        if (item.quantity <= 0) { continue } // nothing real to show, leave alone
        console.log(`  + create batch row: ${item.name} = ${item.quantity}${item.unit} @ ${item.unitCost}`)
        createdRows++
        if (COMMIT) {
          await prisma.inventoryPurchase.create({
            data: {
              restaurantId: b.restaurantId,
              branchId: b.id,
              ingredientId: item.id,
              quantityPurchased: item.quantity,
              remainingQuantity: item.quantity,
              unitCost: item.unitCost,
              totalCost: Math.round(item.quantity * item.unitCost * 100) / 100,
              purchaseQuantity: item.quantity,
              purchaseUnit: item.unit,
              purchaseUnitCost: item.unitCost,
              unitsPerPurchaseUnit: 1,
            },
          })
        }
        continue
      }

      if (!drift) continue // already fine, don't touch

      if (item.quantity <= 0) { leftGenuinelyZero++; continue } // real stock is 0 too, nothing to sync to

      const [primary, ...rest2] = rows
      console.log(`  ~ fix drift: ${item.name}  (layer sum ${layerSum} -> ${item.quantity}${item.unit})`)
      fixedDrift++
      if (COMMIT) {
        await prisma.inventoryPurchase.update({
          where: { id: primary.id },
          data: {
            quantityPurchased: item.quantity,
            remainingQuantity: item.quantity,
            unitCost: item.unitCost,
            totalCost: Math.round(item.quantity * item.unitCost * 100) / 100,
            purchaseQuantity: item.quantity,
            purchaseUnit: item.unit,
            purchaseUnitCost: item.unitCost,
            unitsPerPurchaseUnit: 1,
          },
        })
        for (const r of rest2) {
          await prisma.inventoryPurchase.update({ where: { id: r.id }, data: { quantityPurchased: 0, remainingQuantity: 0, unitCost: 0, totalCost: 0 } })
        }
      }
    }
  }

  console.log(`\nFixed drift: ${fixedDrift}. Created missing rows: ${createdRows}. Left genuinely-zero (nothing to sync): ${leftGenuinelyZero}.`)
  console.log(`${COMMIT ? 'Committed.' : 'Dry run — re-run with --commit to apply.'}\n`)
}
main().catch(e => console.error('FATAL:', e.message)).finally(() => prisma.$disconnect())
