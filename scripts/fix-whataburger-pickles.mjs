/**
 * WHATABURGER Pickles (2026-07-14): the batch was entered as "5 pcs @ 8,000"
 * but the owner actually bought 5 BOTTLES of 10 pcs @ 8,000/bottle.
 * → purchase: 5 bottles ×10 = 50 pcs @ 800/pc (total 40,000 unchanged),
 *   3 pcs already consumed stay consumed (remaining 47), item 47 pcs @ 800/pc.
 * Also soft-deletes the empty duplicate item "pickles" (g, no history).
 */
import { createRequire } from 'module'
import { resolve } from 'path'
import { readFileSync } from 'fs'
import { randomUUID } from 'crypto'
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

const ITEM_ID = 'cmqjltdgj000j13q9iwkyykpx'   // Pickles (pcs), WHATABURGER
const DUP_ID  = 'cmrg8yq8a004365zptsmx1ni3'   // pickles (g) — empty duplicate

const item = await prisma.inventoryItem.findUnique({
  where: { id: ITEM_ID },
  select: { restaurantId: true, branchId: true, purchases: { where: { deletedAt: null }, select: { id: true, quantityPurchased: true, remainingQuantity: true } } },
})
if (item.purchases.length !== 1) throw new Error(`Expected 1 purchase, found ${item.purchases.length}`)
const p = item.purchases[0]
const consumed = p.quantityPurchased - p.remainingQuantity   // 3 pcs
const grams = null // n/a — stays in pcs

const BOTTLES = 5, PCS_PER_BOTTLE = 10, COST_PER_BOTTLE = 8000
const totalPcs = BOTTLES * PCS_PER_BOTTLE
const perPc = COST_PER_BOTTLE / PCS_PER_BOTTLE
const remaining = totalPcs - consumed

const outbox = (entityType, entityId, payload) => ({
  scopeId: item.restaurantId, restaurantId: item.restaurantId, branchId: item.branchId,
  entityType, entityId, operation: 'upsert', payload: JSON.stringify(payload),
  mutationId: randomUUID(), sourceDeviceId: 'cloud', availableAt: new Date(),
})

await prisma.$transaction(async tx => {
  const purchase = await tx.inventoryPurchase.update({
    where: { id: p.id },
    data: {
      purchaseQuantity: BOTTLES, purchaseUnit: 'bottle', unitsPerPurchaseUnit: PCS_PER_BOTTLE,
      purchaseUnitCost: COST_PER_BOTTLE, quantityPurchased: totalPcs,
      remainingQuantity: remaining, unitCost: perPc, totalCost: BOTTLES * COST_PER_BOTTLE,
    },
  })
  const updatedItem = await tx.inventoryItem.update({
    where: { id: ITEM_ID },
    data: { quantity: remaining, unitCost: perPc },
  })
  const dup = await tx.inventoryItem.update({
    where: { id: DUP_ID },
    data: { deletedAt: new Date() },
  })
  await tx.syncOutbox.create({ data: outbox('inventoryPurchase', purchase.id, purchase) })
  await tx.syncOutbox.create({ data: outbox('inventoryItem', updatedItem.id, updatedItem) })
  await tx.syncOutbox.create({ data: { ...outbox('inventoryItem', dup.id, dup), operation: 'delete', payload: JSON.stringify({ id: dup.id }) } })
  console.log(`Pickles: ${BOTTLES} bottles ×${PCS_PER_BOTTLE} = ${totalPcs} pcs @ ${perPc}/pc; consumed ${consumed} → remaining ${remaining}; duplicate 'pickles' (g) removed`)
}, { timeout: 30000 })

await prisma.$disconnect()
console.log('Done.')
