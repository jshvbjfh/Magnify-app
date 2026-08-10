/**
 * High 5ive (2026-07-14): move ALL Hot Beverages from Parking Bar to Banana
 * Bar — 14 dishes with recipes + the stock behind them.
 *  - Coffee Beans, Chocolate Powder: exclusive to hot bevs → item + batches
 *    move branches; recipes keep pointing at the same item ids.
 *  - Milk: Banana Bar already has a Milk item → MERGE: Parking's batch and
 *    quantity fold into Banana's Milk, hot-bev recipes repoint to it, the
 *    Parking Milk item is soft-deleted. Guarded: units must match.
 *  - Sale history is untouched (DishSale stamps its own branch).
 *  - Outbox rows notify synced portals; waiter tills refresh via pull.
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

const REST = 'cmqia7buf0003n5p19gkoov3k'
const PARKING = 'cmqiagbtb0010n5p1utvhc8s6'
const BANANA = 'cmqiafute000vn5p1zcngyawx'

await prisma.$transaction(async tx => {
  const outbox = (entityType, entityId, operation, payload) => tx.syncOutbox.create({
    data: {
      scopeId: REST, restaurantId: REST, branchId: BANANA,
      entityType, entityId, operation, payload: JSON.stringify(payload),
      mutationId: randomUUID(), sourceDeviceId: 'cloud', availableAt: new Date(),
    },
  })

  // ── 1. Milk merge (guarded) ──
  const parkingMilk = await tx.inventoryItem.findFirst({
    where: { branchId: PARKING, name: 'Milk', deletedAt: null },
    select: { id: true, unit: true, quantity: true },
  })
  const bananaMilk = await tx.inventoryItem.findFirst({
    where: { branchId: BANANA, name: 'Milk', deletedAt: null },
    select: { id: true, unit: true, quantity: true },
  })
  if (!parkingMilk || !bananaMilk) throw new Error('Milk item missing on one side')
  if (parkingMilk.unit.toLowerCase() !== bananaMilk.unit.toLowerCase()) {
    throw new Error(`Milk units differ (Parking ${parkingMilk.unit} vs Banana ${bananaMilk.unit}) — aborting, needs manual conversion`)
  }

  const milkBatches = await tx.inventoryPurchase.updateMany({
    where: { ingredientId: parkingMilk.id, deletedAt: null },
    data: { ingredientId: bananaMilk.id, branchId: BANANA },
  })
  const mergedBanana = await tx.inventoryItem.update({
    where: { id: bananaMilk.id },
    data: { quantity: { increment: parkingMilk.quantity } },
  })
  const milkRecipes = await tx.dishIngredient.updateMany({
    where: { inventoryItemId: parkingMilk.id },
    data: { inventoryItemId: bananaMilk.id },
  })
  const deletedParkingMilk = await tx.inventoryItem.update({
    where: { id: parkingMilk.id },
    data: { deletedAt: new Date() },
  })
  await outbox('inventoryItem', bananaMilk.id, 'upsert', mergedBanana)
  await outbox('inventoryItem', parkingMilk.id, 'delete', { id: parkingMilk.id })
  console.log(`Milk: merged ${parkingMilk.quantity}${parkingMilk.unit} into Banana Bar (now ${mergedBanana.quantity}${mergedBanana.unit}); ${milkBatches.count} batch(es), ${milkRecipes.count} recipe lines repointed; Parking Milk removed`)
  void deletedParkingMilk

  // ── 2. Coffee Beans + Chocolate Powder: move item + batches ──
  for (const name of ['Coffee Beans', 'Chocolate Powder']) {
    const item = await tx.inventoryItem.findFirst({
      where: { branchId: PARKING, name, deletedAt: null }, select: { id: true },
    })
    if (!item) throw new Error(`Not found in Parking Bar: ${name}`)
    const moved = await tx.inventoryItem.update({ where: { id: item.id }, data: { branchId: BANANA } })
    const batches = await tx.inventoryPurchase.updateMany({
      where: { ingredientId: item.id, deletedAt: null },
      data: { branchId: BANANA },
    })
    await outbox('inventoryItem', item.id, 'upsert', moved)
    console.log(`${name}: moved to Banana Bar (${batches.count} batch(es))`)
  }

  // ── 3. Move the 14 dishes ──
  const dishes = await tx.dish.findMany({
    where: { branchId: PARKING, category: 'Hot Beverages', deletedAt: null },
    select: { id: true, name: true },
  })
  const moved = await tx.dish.updateMany({
    where: { id: { in: dishes.map(d => d.id) } },
    data: { branchId: BANANA },
  })
  for (const d of dishes) {
    const full = await tx.dish.findUnique({ where: { id: d.id } })
    await outbox('dish', d.id, 'upsert', full)
  }
  console.log(`Dishes: ${moved.count} hot beverages moved to Banana Bar (${dishes.map(d => d.name).join(', ')})`)
}, { timeout: 120000, maxWait: 10000 })

await prisma.$disconnect()
console.log('\nDone. Waiter tills pick this up on their next sync.')
