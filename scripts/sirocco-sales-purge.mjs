// Hard-deletes every order and sale belonging to SIROCCO Y SOL — the test data
// rung up during onboarding (14–16 Aug 2026). Menu, staff, stock, tables and
// purchase accounting are left completely untouched.
//
//   node scripts/sirocco-sales-purge.mjs            → dry run, writes nothing
//   node scripts/sirocco-sales-purge.mjs --execute   → performs the deletion
//
// Purchase journal entries are identified and EXCLUDED: only entries that a
// sale created (referenced by an order, or reference 'order:…') are removed.
// Stock the sales consumed is handed back to its FIFO batch rather than left
// depleted — existing purchase rows are updated, never re-created.
import fs from 'fs'

const EXECUTE = process.argv.includes('--execute')

const env = {}
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/)
  if (m) env[m[1]] = m[2]
}
for (const k of ['DATABASE_URL', 'DIRECT_URL']) if (env[k]) process.env[k] = env[k]

const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()

const say = (s = '') => console.log(s)
say(`MODE: ${EXECUTE ? '*** EXECUTE — THIS WRITES ***' : 'dry run (no writes)'}`)
say(`DB host: ${(process.env.DATABASE_URL || '').match(/@([^/:?]+)/)?.[1] ?? '(none)'}\n`)

const r = await p.restaurant.findFirst({
  where: { name: { contains: 'rocco', mode: 'insensitive' } },
  select: { id: true, name: true },
})
if (!r) { say('No Sirocco restaurant — nothing to do.'); await p.$disconnect(); process.exit(0) }
const RID = r.id
say(`Restaurant: ${r.name} (${RID})\n`)

// ── Gather everything first, so the dry run reports exactly what --execute does ──
const orders = await p.restaurantOrder.findMany({
  where: { restaurantId: RID },
  select: { id: true, journalEntryId: true, status: true, totalAmount: true },
})
const orderIds = orders.map(o => o.id)
const orderJeIds = orders.map(o => o.journalEntryId).filter(Boolean)

const items = await p.orderItem.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } })
const itemIds = items.map(i => i.id)

const dishSales = await p.dishSale.findMany({ where: { restaurantId: RID }, select: { id: true } })
const dishSaleIds = dishSales.map(d => d.id)

const dsIngCount = await p.dishSaleIngredient.count({ where: { dishSaleId: { in: dishSaleIds } } })

// Journal entries a sale produced. A purchase entry is never in this set: it is
// reached only through InventoryPurchase.journalEntryId, which we exclude below.
const candidateJes = await p.journalEntry.findMany({
  where: {
    restaurantId: RID,
    OR: [{ id: { in: orderJeIds } }, { reference: { startsWith: 'order:' } }],
  },
  select: { id: true, description: true, reference: true },
})
const purchaseJeIds = new Set(
  (await p.inventoryPurchase.findMany({
    where: { restaurantId: RID, journalEntryId: { not: null } },
    select: { journalEntryId: true },
  })).map(x => x.journalEntryId)
)
const saleJeIds = candidateJes.map(j => j.id).filter(id => !purchaseJeIds.has(id))
const saleJeLines = await p.journalLine.count({ where: { journalEntryId: { in: saleJeIds } } })

// Stock consumed by these sales — to be returned to its batch.
const ledgerRows = await p.inventoryBatchUsageLedger.findMany({
  where: { restaurantId: RID, sourceType: 'dishSale' },
  select: { id: true, purchaseId: true, ingredientId: true, quantityConsumed: true, sourceId: true },
})
const restores = ledgerRows.filter(l => dishSaleIds.includes(l.sourceId) || !l.sourceId)

const outboxIds = (await p.syncOutbox.findMany({
  where: { restaurantId: RID, entityId: { in: [...orderIds, ...itemIds, ...dishSaleIds] } },
  select: { id: true, entityType: true },
}))
const outboxByType = {}
for (const o of outboxIds) outboxByType[o.entityType] = (outboxByType[o.entityType] || 0) + 1

const paid = orders.filter(o => o.status === 'PAID')
const pending = orders.filter(o => o.status !== 'PAID')

say('WILL DELETE')
say(`  restaurant_orders            ${orders.length}   (${paid.length} PAID / ${pending.length} PENDING, value ${orders.reduce((s, o) => s + (o.totalAmount || 0), 0).toFixed(2)})`)
say(`  order_items                  ${itemIds.length}`)
say(`  dish_sales                   ${dishSaleIds.length}`)
say(`  dish_sale_ingredients        ${dsIngCount}`)
say(`  journal_entries (sales only) ${saleJeIds.length}`)
say(`  journal_lines                ${saleJeLines}`)
say(`  batch usage ledger rows      ${restores.length}   (stock handed back to its batch)`)
say(`  sync_outbox rows             ${outboxIds.length}   ${JSON.stringify(outboxByType)}`)
say('\nWILL KEEP UNTOUCHED')
say(`  purchase journal entries     ${purchaseJeIds.size}`)
say('  dishes, menu, categories, staff, tables, inventory items & purchases')

if (restores.length) {
  say('\nSTOCK TO RESTORE')
  for (const l of restores) {
    const ing = await p.inventoryItem.findUnique({ where: { id: l.ingredientId }, select: { name: true, unit: true, quantity: true } })
    say(`  +${l.quantityConsumed} ${ing?.unit ?? ''} ${ing?.name ?? l.ingredientId}  (now ${ing?.quantity})`)
  }
}

if (!EXECUTE) {
  say('\nDry run only — nothing was written. Re-run with --execute to apply.')
  await p.$disconnect()
  process.exit(0)
}

// ── Execute ───────────────────────────────────────────────────────────────
// Deletion order follows the FK graph: children first, and the orders' FK to
// their journal entry is cleared before those entries go.
say('\n--- executing ---')

const del = async (label, fn) => { const n = await fn(); say(`  deleted ${label}: ${typeof n === 'object' ? n.count : n}`) }

// Hand stock back to the batch it was taken from before the ledger row goes.
for (const l of restores) {
  await p.inventoryPurchase.update({
    where: { id: l.purchaseId },
    data: { remainingQuantity: { increment: l.quantityConsumed } },
  })
  await p.inventoryItem.update({
    where: { id: l.ingredientId },
    data: { quantity: { increment: l.quantityConsumed } },
  })
  say(`  restored ${l.quantityConsumed} to batch ${l.purchaseId}`)
}
if (restores.length) {
  await del('batch usage ledger rows', () => p.inventoryBatchUsageLedger.deleteMany({ where: { id: { in: restores.map(l => l.id) } } }))
}

await del('dish_sale_ingredients', () => p.dishSaleIngredient.deleteMany({ where: { dishSaleId: { in: dishSaleIds } } }))
await del('dish_sales', () => p.dishSale.deleteMany({ where: { id: { in: dishSaleIds } } }))
await del('order_items', () => p.orderItem.deleteMany({ where: { orderId: { in: orderIds } } }))

// Break the order → journal entry FK so the entries can be removed.
await p.restaurantOrder.updateMany({ where: { id: { in: orderIds } }, data: { journalEntryId: null } })
await del('restaurant_orders', () => p.restaurantOrder.deleteMany({ where: { id: { in: orderIds } } }))

await del('journal_lines', () => p.journalLine.deleteMany({ where: { journalEntryId: { in: saleJeIds } } }))
await del('journal_entries', () => p.journalEntry.deleteMany({ where: { id: { in: saleJeIds } } }))

await del('sync_outbox rows', () => p.syncOutbox.deleteMany({ where: { id: { in: outboxIds.map(o => o.id) } } }))

// The test shift is stale (business date 13 Aug). Left OPEN it would stamp every
// real sale from here on with that day, so it goes with the orders it held.
// Safe only now that no order references it.
await del('service_shifts', () => p.shift.deleteMany({ where: { restaurantId: RID } }))

// Any table left marked occupied by a purged order must go back to available.
await del('table statuses reset', () => p.restaurantTable.updateMany({ where: { restaurantId: RID, status: { not: 'available' } }, data: { status: 'available' } }))

say('\n--- verifying ---')
for (const [label, n] of [
  ['restaurant_orders', await p.restaurantOrder.count({ where: { restaurantId: RID } })],
  ['dish_sales', await p.dishSale.count({ where: { restaurantId: RID } })],
  ['journal_entries left', await p.journalEntry.count({ where: { restaurantId: RID } })],
  ['dishes (kept)', await p.dish.count({ where: { restaurantId: RID } })],
  ['inventory items (kept)', await p.inventoryItem.count({ where: { restaurantId: RID } })],
  ['staff (kept)', await p.staff.count({ where: { restaurantId: RID } })],
]) say(`  ${label.padEnd(24)} ${n}`)

await p.$disconnect()
