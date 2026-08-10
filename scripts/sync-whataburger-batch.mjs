/**
 * Sync the WHATABURGER batch B-06182026-57D54C purchase rows to match the
 * already-correct InventoryItem quantity/unitCost (fixes the item-vs-batch
 * drift causing "Tot. stock value" to show 0 for items that do have real
 * stock + cost). Only UPDATEs existing InventoryPurchase rows — no creates.
 * Mustard is corrected from its wrong 1 pcs/6,300-per-pcs entry to the real
 * 500 pcs/12.6-per-pcs (same 6,300 total).
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
const BATCH_ID = 'B-06182026-57D54C'

async function main() {
  console.log(`\n${COMMIT ? '🟢 COMMIT' : '🟡 DRY RUN'} — sync WHATABURGER batch ${BATCH_ID} to item-level truth\n`)

  const branch = await prisma.branch.findFirst({ where: { name: { contains: 'WHATABURGER', mode: 'insensitive' } }, select: { id: true, restaurantId: true } })
  if (!branch) throw new Error('WHATABURGER branch not found')

  const items = await prisma.inventoryItem.findMany({ where: { branchId: branch.id, deletedAt: null }, select: { id: true, name: true, unit: true, quantity: true, unitCost: true } })
  const purchases = await prisma.inventoryPurchase.findMany({ where: { branchId: branch.id, batchId: BATCH_ID, deletedAt: null }, select: { id: true, ingredientId: true, quantityPurchased: true, remainingQuantity: true, unitCost: true, totalCost: true } })

  let updated = 0
  for (const p of purchases) {
    const item = items.find(i => i.id === p.ingredientId)
    if (!item) continue
    const targetQty = item.quantity
    const targetUnitCost = item.unitCost
    const drift = Math.abs(p.remainingQuantity - targetQty) > 0.001 || Math.abs(p.unitCost - targetUnitCost) > 0.001
    if (!drift) { console.log(`  = ${item.name} — already in sync`); continue }
    const totalCost = Math.round(targetQty * targetUnitCost * 100) / 100
    console.log(`  ~ ${item.name}: qty ${p.quantityPurchased}->${targetQty}, unitCost ${p.unitCost}->${targetUnitCost}, total ${p.totalCost}->${totalCost}`)
    updated++
    if (COMMIT) {
      await prisma.inventoryPurchase.update({
        where: { id: p.id },
        data: {
          quantityPurchased: targetQty,
          remainingQuantity: targetQty,
          unitCost: targetUnitCost,
          totalCost,
          purchaseQuantity: targetQty,
          purchaseUnit: item.unit,
          purchaseUnitCost: targetUnitCost,
          unitsPerPurchaseUnit: 1,
        },
      })
    }
  }

  console.log(`\nUpdated: ${updated} row(s).  ${COMMIT ? 'Committed.' : 'Dry run — re-run with --commit to apply.'}\n`)
}
main().catch(e => console.error('FATAL:', e.message)).finally(() => prisma.$disconnect())
