// READ-ONLY audit of every sales/order artefact belonging to SIROCCO Y SOL.
// Writes nothing. Run before scripts/sirocco-sales-purge.mjs.
import fs from 'fs'

const env = {}
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/)
  if (m) env[m[1]] = m[2]
}
for (const k of ['DATABASE_URL', 'DIRECT_URL']) if (env[k]) process.env[k] = env[k]

const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
console.log('DB host:', (process.env.DATABASE_URL || '').match(/@([^/:?]+)/)?.[1] ?? '(none)')

const r = await p.restaurant.findFirst({
  where: { name: { contains: 'rocco', mode: 'insensitive' } },
  select: { id: true, name: true, branches: { select: { id: true, name: true } } },
})
if (!r) { console.log('No Sirocco restaurant.'); await p.$disconnect(); process.exit(0) }

const RID = r.id
const branchIds = r.branches.map(b => b.id)
const bName = Object.fromEntries(r.branches.map(b => [b.id, b.name]))
console.log(`\n${r.name}  (${RID})  branches: ${branchIds.length}\n`)

// ── Orders ────────────────────────────────────────────────────────────────
const orders = await p.restaurantOrder.findMany({
  where: { restaurantId: RID },
  select: {
    id: true, orderNumber: true, status: true, totalAmount: true, branchId: true,
    tableName: true, createdByName: true, paidAt: true, createdAt: true,
    journalEntryId: true, shiftId: true, deletedAt: true,
  },
  orderBy: { createdAt: 'asc' },
})
const orderIds = orders.map(o => o.id)

const byStatus = {}
for (const o of orders) {
  const k = o.deletedAt ? `${o.status} (soft-deleted)` : o.status
  byStatus[k] ??= { n: 0, amount: 0 }
  byStatus[k].n++
  byStatus[k].amount += o.totalAmount || 0
}
console.log('ORDERS by status:')
for (const [k, v] of Object.entries(byStatus)) console.log(`  ${k.padEnd(26)} ${String(v.n).padStart(3)}   total ${v.amount.toFixed(2)}`)
console.log(`  ${'TOTAL'.padEnd(26)} ${String(orders.length).padStart(3)}\n`)

console.log('ORDER LIST:')
for (const o of orders) {
  console.log(`  ${o.orderNumber.padEnd(12)} ${o.status.padEnd(10)} ${String(o.totalAmount ?? 0).padStart(9)}  ${(bName[o.branchId] || '?').padEnd(16)} table=${o.tableName ?? '-'}  by=${o.createdByName ?? '-'}  ${o.createdAt.toISOString().slice(0, 16)}${o.journalEntryId ? '  JE' : ''}${o.deletedAt ? '  DELETED' : ''}`)
}

// ── Dependents ────────────────────────────────────────────────────────────
const items = await p.orderItem.count({ where: { orderId: { in: orderIds } } })

const dishSales = await p.dishSale.findMany({
  where: { restaurantId: RID },
  select: { id: true, totalSaleAmount: true, orderId: true, branchId: true },
})
const dishSaleIds = dishSales.map(d => d.id)
const dsIng = await p.dishSaleIngredient.count({ where: { dishSaleId: { in: dishSaleIds } } })
const orphanSales = dishSales.filter(d => !d.orderId || !orderIds.includes(d.orderId)).length

const jes = await p.journalEntry.findMany({
  where: { restaurantId: RID },
  select: { id: true, description: true, reference: true, entryDate: true, branchId: true },
  orderBy: { entryDate: 'asc' },
})
const jeIds = jes.map(j => j.id)
const jLines = await p.journalLine.count({ where: { journalEntryId: { in: jeIds } } })

// The pooled Neon connection allows a single connection, so these must run
// one at a time — a Promise.all here exhausts the pool and times out.
const creditSales = await p.creditSale.findMany({ where: { restaurantId: RID }, select: { id: true, customerName: true, amount: true, paidAt: true } })
const ledger = await p.inventoryBatchUsageLedger.findMany({ where: { restaurantId: RID }, select: { id: true, sourceType: true, purchaseId: true, ingredientId: true, quantityConsumed: true, sourceId: true } })
const shifts = await p.shift.findMany({ where: { restaurantId: RID }, select: { id: true, businessDate: true, status: true, openedByName: true } })
const empShifts = await p.employeeShift.count({ where: { restaurantId: RID } })
const tables = await p.restaurantTable.findMany({ where: { restaurantId: RID }, select: { id: true, name: true, status: true } })
const outbox = await p.syncOutbox.count({ where: { restaurantId: RID } })
const conflicts = await p.syncConflictLog.count({ where: { restaurantId: RID } })
const prepLogs = await p.prepLog.count({ where: { restaurantId: RID } })
const mepItems = await p.mepListItem.count({ where: { restaurantId: RID } })
const waste = await p.wasteLog.count({ where: { restaurantId: RID } })
const adjustments = await p.inventoryAdjustmentLog.count({ where: { restaurantId: RID } })
const stockTakes = await p.stockTake.count({ where: { restaurantId: RID } })

const ledgerByType = {}
for (const l of ledger) ledgerByType[l.sourceType] = (ledgerByType[l.sourceType] || 0) + 1

console.log('\nDEPENDENT / RELATED RECORDS')
console.log(`  order_items                 ${items}`)
console.log(`  dish_sales                  ${dishSales.length}   (value ${dishSales.reduce((s, d) => s + (d.totalSaleAmount || 0), 0).toFixed(2)}, not linked to an order above: ${orphanSales})`)
console.log(`  dish_sale_ingredients       ${dsIng}`)
console.log(`  journal_entries             ${jes.length}`)
console.log(`  journal_lines               ${jLines}`)
console.log(`  credit_sales                ${creditSales.length}`)
console.log(`  batch usage ledger          ${ledger.length}   ${JSON.stringify(ledgerByType)}`)
console.log(`  service_shifts              ${shifts.length}   ${shifts.map(s => `${s.businessDate.toISOString().slice(0, 10)}/${s.status}`).join(', ')}`)
console.log(`  employee_shifts             ${empShifts}`)
console.log(`  sync_outbox                 ${outbox}`)
console.log(`  sync_conflict_logs          ${conflicts}`)
console.log(`  tables not 'available'      ${tables.filter(t => t.status !== 'available').length} of ${tables.length}   ${tables.filter(t => t.status !== 'available').map(t => `${t.name}:${t.status}`).join(', ')}`)
console.log('\nNOT SALES — left alone unless you say otherwise:')
console.log(`  prep_logs                   ${prepLogs}`)
console.log(`  mep_list_items              ${mepItems}`)
console.log(`  waste_logs                  ${waste}`)
console.log(`  inventory_adjustment_logs   ${adjustments}`)
console.log(`  stock_takes                 ${stockTakes}`)

console.log('\nJOURNAL ENTRIES:')
for (const j of jes) console.log(`  ${j.entryDate.toISOString().slice(0, 16)}  ${(j.reference ?? '-').padEnd(18)} ${j.description ?? ''}`)

if (creditSales.length) {
  console.log('\nCREDIT SALES:')
  for (const c of creditSales) console.log(`  ${c.customerName.padEnd(24)} ${String(c.amount).padStart(10)}  ${c.paidAt ? 'collected' : 'OUTSTANDING'}`)
}

// Stock that sales consumed — what a purge would need to hand back.
const saleLedger = ledger.filter(l => l.sourceType !== 'prep' && l.sourceType !== 'prep_production')
console.log(`\nSTOCK CONSUMED BY SALES: ${saleLedger.length} ledger rows across ${new Set(saleLedger.map(l => l.purchaseId)).size} purchase batches, ${new Set(saleLedger.map(l => l.ingredientId)).size} ingredients`)

await p.$disconnect()
