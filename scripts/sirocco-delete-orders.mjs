// Hard-deletes specific Sirocco y Sol orders, leaving no trace: the order rows,
// their items, any sale/accounting records that hang off them, and the sync
// outbox entries that would otherwise re-push them to a till.
//
//   node scripts/sirocco-delete-orders.mjs WA-1234 WA-5678            → dry run
//   node scripts/sirocco-delete-orders.mjs WA-1234 WA-5678 --execute  → deletes
//
// Refuses to touch a PAID order unless --allow-paid is passed: a settled sale
// has revenue and stock behind it, and deleting it silently would leave the
// books short without anyone noticing.
import fs from 'fs'

const EXECUTE = process.argv.includes('--execute')
const ALLOW_PAID = process.argv.includes('--allow-paid')
const NUMBERS = process.argv.slice(2).filter((a) => !a.startsWith('--'))
if (!NUMBERS.length) {
  console.error('usage: node scripts/sirocco-delete-orders.mjs <orderNumber...> [--execute] [--allow-paid]')
  process.exit(1)
}

const env = {}
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/)
  if (m) env[m[1]] = m[2]
}
for (const k of ['DATABASE_URL', 'DIRECT_URL']) if (env[k]) process.env[k] = env[k]

const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
console.log(`MODE: ${EXECUTE ? '*** EXECUTE ***' : 'dry run (no writes)'}`)
console.log('DB host:', (process.env.DATABASE_URL || '').match(/@([^/:?]+)/)?.[1] ?? '(none)', '\n')

const r = await p.restaurant.findFirst({
  where: { name: { contains: 'rocco', mode: 'insensitive' } },
  select: { id: true, name: true },
})
if (!r) { console.log('No Sirocco restaurant.'); await p.$disconnect(); process.exit(0) }

const orders = await p.restaurantOrder.findMany({
  where: { restaurantId: r.id, orderNumber: { in: NUMBERS } },
  select: {
    id: true, orderNumber: true, status: true, totalAmount: true,
    tableName: true, createdByName: true, journalEntryId: true, createdAt: true,
  },
})

const found = new Set(orders.map((o) => o.orderNumber))
const missing = NUMBERS.filter((n) => !found.has(n))
if (missing.length) console.log('NOT FOUND (already gone?):', missing.join(', '))

if (!orders.length) { console.log('Nothing to delete.'); await p.$disconnect(); process.exit(0) }

console.log(`\nMATCHED ${orders.length} order(s) in ${r.name}:`)
for (const o of orders) {
  console.log(`  ${o.orderNumber.padEnd(13)} ${o.status.padEnd(9)} ${String(o.totalAmount).padStart(8)}  table=${o.tableName ?? '-'}  by=${o.createdByName ?? '-'}  ${o.createdAt.toISOString().slice(0, 16)}`)
}

const paid = orders.filter((o) => o.status === 'PAID')
if (paid.length && !ALLOW_PAID) {
  console.log(`\nREFUSING: ${paid.length} of these are PAID (${paid.map((o) => o.orderNumber).join(', ')}).`)
  console.log('A settled sale carries revenue, COGS and stock movements. Re-run with --allow-paid only if you really mean it.')
  await p.$disconnect()
  process.exit(1)
}

const orderIds = orders.map((o) => o.id)
const items = await p.orderItem.count({ where: { orderId: { in: orderIds } } })
const dishSales = await p.dishSale.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } })
const dishSaleIds = dishSales.map((d) => d.id)
const dsIng = await p.dishSaleIngredient.count({ where: { dishSaleId: { in: dishSaleIds } } })
const ledger = await p.inventoryBatchUsageLedger.findMany({
  where: { restaurantId: r.id, sourceType: 'dishSale', sourceId: { in: dishSaleIds } },
  select: { id: true, purchaseId: true, ingredientId: true, quantityConsumed: true },
})
const jeIds = orders.map((o) => o.journalEntryId).filter(Boolean)
const jLines = jeIds.length ? await p.journalLine.count({ where: { journalEntryId: { in: jeIds } } }) : 0
const outbox = await p.syncOutbox.findMany({
  where: { restaurantId: r.id, entityId: { in: [...orderIds, ...dishSaleIds] } },
  select: { id: true },
})

console.log('\nWILL DELETE')
console.log(`  restaurant_orders       ${orders.length}`)
console.log(`  order_items             ${items}`)
console.log(`  dish_sales              ${dishSaleIds.length}`)
console.log(`  dish_sale_ingredients   ${dsIng}`)
console.log(`  journal_entries         ${jeIds.length}   (+ ${jLines} lines)`)
console.log(`  batch usage ledger      ${ledger.length}   (stock handed back)`)
console.log(`  sync_outbox rows        ${outbox.length}   (else a till could re-push them)`)

if (!EXECUTE) {
  console.log('\nDry run — nothing written. Re-run with --execute.')
  await p.$disconnect()
  process.exit(0)
}

console.log('\n--- executing ---')
// Stock first: hand consumed quantities back before the ledger rows disappear.
for (const l of ledger) {
  await p.inventoryPurchase.update({ where: { id: l.purchaseId }, data: { remainingQuantity: { increment: l.quantityConsumed } } })
  await p.inventoryItem.update({ where: { id: l.ingredientId }, data: { quantity: { increment: l.quantityConsumed } } })
  console.log(`  restored ${l.quantityConsumed} to batch ${l.purchaseId}`)
}
if (ledger.length) await p.inventoryBatchUsageLedger.deleteMany({ where: { id: { in: ledger.map((l) => l.id) } } })

const del = async (label, fn) => { const n = await fn(); console.log(`  deleted ${label}: ${n.count ?? n}`) }
await del('dish_sale_ingredients', () => p.dishSaleIngredient.deleteMany({ where: { dishSaleId: { in: dishSaleIds } } }))
await del('dish_sales', () => p.dishSale.deleteMany({ where: { id: { in: dishSaleIds } } }))
await del('order_items', () => p.orderItem.deleteMany({ where: { orderId: { in: orderIds } } }))

// Break the order -> journal entry FK before removing those entries.
await p.restaurantOrder.updateMany({ where: { id: { in: orderIds } }, data: { journalEntryId: null } })
await del('restaurant_orders', () => p.restaurantOrder.deleteMany({ where: { id: { in: orderIds } } }))
if (jeIds.length) {
  await del('journal_lines', () => p.journalLine.deleteMany({ where: { journalEntryId: { in: jeIds } } }))
  await del('journal_entries', () => p.journalEntry.deleteMany({ where: { id: { in: jeIds } } }))
}
await del('sync_outbox rows', () => p.syncOutbox.deleteMany({ where: { id: { in: outbox.map((o) => o.id) } } }))
await del('table statuses reset', () => p.restaurantTable.updateMany({ where: { restaurantId: r.id, status: { not: 'available' } }, data: { status: 'available' } }))

const left = await p.restaurantOrder.count({ where: { restaurantId: r.id } })
console.log(`\norders remaining for ${r.name}: ${left}`)

await p.$disconnect()
