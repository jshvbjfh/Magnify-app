/**
 * Backfill InventoryPurchase.purchaseUnitCost for High 5ive rows where it's
 * 0 (or null) but unitCost (the real, usage-unit cost driving stock
 * valuation) is set. purchaseUnitCost is purely a display field (Cost/unit
 * column) - this does not touch quantity, unitCost, or the consumption lock.
 * Formula matches lib/inventoryUnits.ts toPurchaseUnitCost():
 *   purchaseUnitCost = unitCost * (unitsPerPurchaseUnit || 1)
 * Only updates existing InventoryPurchase rows - never creates new ones.
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
const EMAIL = 'high5ive@management.com'
const EPSILON = 0.000001

function roundQuantity(value) {
  return Math.round(value * 1000) / 1000
}

async function main() {
  console.log(`\n${COMMIT ? '🟢 COMMIT' : '🟡 DRY RUN'} — backfill purchaseUnitCost from unitCost\n`)

  const user = await prisma.user.findUnique({ where: { email: EMAIL }, select: { id: true } })
  if (!user) { console.log(`No user found for ${EMAIL}`); return }
  const rest = await prisma.restaurant.findFirst({ where: { ownerId: user.id }, select: { id: true, name: true } })
  const branches = await prisma.branch.findMany({ where: { restaurantId: rest.id }, select: { id: true, name: true } })

  let fixed = 0, skipped = 0

  for (const branch of branches) {
    const purchases = await prisma.inventoryPurchase.findMany({
      where: { branchId: branch.id, deletedAt: null },
      select: {
        id: true, unitCost: true, purchaseUnitCost: true, unitsPerPurchaseUnit: true,
        ingredient: { select: { name: true, unit: true } },
      },
    })

    const toFix = purchases.filter(p => (p.purchaseUnitCost ?? 0) <= EPSILON && (p.unitCost ?? 0) > EPSILON)
    if (!toFix.length) continue

    console.log(`\n=== ${branch.name} (${toFix.length} rows) ===`)
    for (const p of toFix) {
      const factor = p.unitsPerPurchaseUnit && p.unitsPerPurchaseUnit > 0 ? p.unitsPerPurchaseUnit : 1
      const newPurchaseUnitCost = roundQuantity(p.unitCost * factor)
      console.log(`  ${p.ingredient.name.padEnd(24)} unitCost:${p.unitCost}  x${factor}  -> purchaseUnitCost: ${p.purchaseUnitCost} -> ${newPurchaseUnitCost}`)
      if (COMMIT) {
        await prisma.inventoryPurchase.update({ where: { id: p.id }, data: { purchaseUnitCost: newPurchaseUnitCost } })
      }
      fixed++
    }
    skipped += purchases.length - toFix.length
  }

  console.log(`\n${'='.repeat(60)}`)
  console.log(`${COMMIT ? 'Fixed' : 'Would fix'}: ${fixed}. Already fine / skipped: ${skipped}.`)
  if (!COMMIT) console.log('Re-run with --commit to apply.')
}

main().catch(e => console.error('FATAL:', e.message)).finally(() => prisma.$disconnect())
