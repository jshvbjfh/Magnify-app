/**
 * Backdated import of 9 real July 22, 2026 receipts (paper tickets, never
 * entered into Magnify — that day was served on a different POS).
 *
 * Reuses the exact real payment pipeline (finalizeRestaurantOrderPayment) that
 * a live paid order goes through, rather than hand-crafting DishSale/JournalEntry
 * rows — this guarantees identical station attribution, FIFO stock consumption,
 * and journal booking to any real order, with the only difference being
 * backdated createdAt/paidAt timestamps taken from the receipts.
 *
 * Every ticket, dish mapping, price, and combined stock draw across all 9
 * tickets has already been independently verified clean (all totals match
 * their receipts exactly, no ingredient goes negative). This script does not
 * re-derive that — it trusts the verification already done and just executes.
 *
 * tableId is deliberately left null (tableName is stored as a label only) so
 * finalizeRestaurantOrderPayment's real-table status flip is skipped entirely —
 * these table numbers don't correspond to currently-open live tables.
 *
 * Run:  node scripts/_import_jul22_receipts.mjs            (dry run — always rolls back)
 *       node scripts/_import_jul22_receipts.mjs --apply
 */
import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'

function readEnvVar(file, key) {
  const content = fs.readFileSync(file, 'utf8')
  const line = content.split('\n').find((l) => l.startsWith(`${key}=`))
  return line ? line.slice(key.length + 1).trim().replace(/^"|"$/g, '') : null
}

const prisma = new PrismaClient({
  datasources: { db: { url: readEnvVar('.env.local', 'DATABASE_URL') } },
})

const apply = process.argv.includes('--apply')
const restaurantId = 'cmqia7buf0003n5p19gkoov3k'

// Kigali time (+02:00), taken directly from the receipt photos. `paperRef` is
// the OTHER POS's own ticket/order number — recorded only in `notes` for
// traceability back to the physical receipt. It is never used as Magnify's own
// orderNumber, which gets a normal ORD-NNNNNN like any order Magnify creates.
const TICKETS = [
  { ticket: 1, paperRef: 'Order #3007 / Ticket #1', server: 'Kenny', table: 'T2', total: 47000,
    created: '2026-07-22T12:44:00+02:00', settled: '2026-07-22T17:55:00+02:00',
    items: [['BAO House Fried Rice (Egg)', 1], ['Spaghetti', 1], ['Add-on: Grilled Chicken', 1], ['Sweet & Sour Wok (Chicken)', 1]] },
  { ticket: 2, paperRef: 'Order #3008 / Ticket #2', server: 'Kenny', table: 'T6', total: 13000,
    created: '2026-07-22T12:56:00+02:00', settled: '2026-07-22T22:31:00+02:00',
    items: [['BAO House Fried Rice (Egg)', 1], ['Water', 1]] },
  { ticket: 4, paperRef: 'Order #3010 / Ticket #4', server: 'Valentine', table: 'T4', total: 29000,
    created: '2026-07-22T13:42:00+02:00', settled: '2026-07-22T17:55:00+02:00',
    items: [['Mango Lemonade', 1], ['Wok Fried Noodles (Veg)', 1], ['Signature Dumplings (Pan-fried)', 1]] },
  { ticket: 5, paperRef: 'Order #3011 / Ticket #5', server: 'Kenny', table: 'T13', total: 21500,
    created: '2026-07-22T17:50:00+02:00', settled: '2026-07-22T22:32:00+02:00',
    items: [['Signature Dumplings (Pan-fried)', 1], ['BAO House Fried Rice (Egg)', 1], ['Coke', 1]] },
  { ticket: 6, paperRef: 'Order #3012 / Ticket #6', server: 'Kenny', table: 'T4', total: 20000,
    created: '2026-07-22T17:57:00+02:00', settled: '2026-07-22T22:30:00+02:00',
    items: [['Skoll Malt', 2], ['Dan Dan Street Noodles', 1]] },
  { ticket: 7, paperRef: 'Order #3013 / Ticket #7', server: 'Kenny', table: 'T2', total: 4500,
    created: '2026-07-22T18:00:00+02:00', settled: '2026-07-22T22:29:00+02:00',
    items: [['Coke', 1], ['Water', 1]] },
  { ticket: 8, paperRef: 'Order #3014 / Ticket #8', server: 'Valentine', table: 'T9', total: 16000,
    created: '2026-07-22T20:31:00+02:00', settled: '2026-07-22T22:31:00+02:00',
    items: [['Brochette (Beef)', 1], ['Fries', 1], ['fresh juice', 1]] },
  { ticket: 9, paperRef: 'Order #3015 / Ticket #9', server: 'Kenny', table: 'T1', total: 31500,
    created: '2026-07-22T20:41:00+02:00', settled: '2026-07-22T22:29:00+02:00',
    items: [['Single Smash Burger', 3], ['Panache', 2], ['SODA', 1]] },
  { ticket: 10, paperRef: 'Order #3016 / Ticket #10', server: 'Valentine', table: 'G2', total: 16000,
    created: '2026-07-22T20:51:00+02:00', settled: '2026-07-22T22:32:00+02:00',
    items: [['Single Smash Burger', 2]] },
]

const IMPORT_NOTE_TAG = 'Paper receipt import (22 Jul 2026, other POS)'

async function runImport(db) {
  console.log(`Mode: ${apply ? '*** APPLY (writing) ***' : 'DRY-RUN (will roll back at the end)'}\n`)

  const orderIds = []
  let grandTotal = 0

  // Real orders get their number from whichever order is currently most recent
  // by createdAt — but every one of these imports is backdated to Jul 22, so
  // each import individually calling that same logic would all compute off
  // TODAY's real latest order and collide on the same number. Resolve the
  // starting point once, then increment locally for this batch, so they land
  // as a normal-looking ORD-NNNNNN sequence appended after today's real orders
  // — the natural result of recording a paper ticket into the system after
  // the fact, same as any other backfill.
  const latest = await db.restaurantOrder.findFirst({
    where: { restaurantId },
    orderBy: { createdAt: 'desc' },
    select: { orderNumber: true },
  })
  let nextOrderSeq = (latest?.orderNumber ? Number(latest.orderNumber.replace(/[^0-9]/g, '')) || 0 : 0) + 1

  for (const t of TICKETS) {
    const resolvedItems = []
    let ticketSum = 0
    for (const [name, qty] of t.items) {
      const dish = await db.dish.findFirst({ where: { restaurantId, name, deletedAt: null } })
      if (!dish) throw new Error(`ABORT — dish not found: ${name}`)
      resolvedItems.push({ dish, qty })
      ticketSum += dish.sellingPrice * qty
    }
    if (ticketSum !== t.total) {
      throw new Error(`ABORT — ticket #${t.ticket} sums to ${ticketSum}, receipt says ${t.total}`)
    }

    const noteText = `${IMPORT_NOTE_TAG} — ${t.paperRef}`
    const existing = await db.restaurantOrder.findFirst({ where: { restaurantId, notes: noteText } })
    if (existing) {
      console.log(`SKIP ticket #${t.ticket} — already imported as ${existing.orderNumber} (order ${existing.id})`)
      continue
    }

    const tillBranchId = resolvedItems[0].dish.branchId

    if (!apply) {
      // Pure read-only preview — no writes, so no transaction/timeout involved.
      // Reuses the exact same dish resolution and validation as the real path;
      // only the actual create + finalize calls are skipped.
      const previewOrderNumber = `ORD-${String(nextOrderSeq).padStart(6, '0')}`
      nextOrderSeq++
      console.log(`WOULD CREATE ticket #${t.ticket} -> ${previewOrderNumber} — ${t.server}, ${t.table}, ${t.created} -> ${t.settled}, ${ticketSum} RWF`)
      for (const { dish, qty } of resolvedItems) console.log(`      ${qty}x ${dish.name} (${dish.sellingPrice} RWF, branch ${dish.branchId})`)
      grandTotal += ticketSum
      continue
    }

    const orderNumber = `ORD-${String(nextOrderSeq).padStart(6, '0')}`
    nextOrderSeq++

    const order = await db.restaurantOrder.create({
      data: {
        restaurantId,
        branchId: tillBranchId,
        tableId: null,
        tableName: t.table,
        orderNumber,
        status: 'PENDING',
        createdByName: t.server,
        notes: noteText,
        createdAt: new Date(t.created),
        items: {
          create: resolvedItems.map(({ dish, qty }) => ({
            dishId: dish.id,
            dishName: dish.name,
            dishPrice: dish.sellingPrice,
            qty,
            branchId: dish.branchId,
            status: 'ACTIVE',
          })),
        },
      },
    })
    orderIds.push(order.id)

    const { finalizeRestaurantOrderPayment } = await import('../lib/restaurantOrderPayment.ts')
    await finalizeRestaurantOrderPayment(db, {
      restaurantId,
      branchId: tillBranchId,
      orderId: order.id,
      paymentMethod: 'Bank',
      paidAt: new Date(t.settled),
    })

    console.log(`OK   ticket #${t.ticket} -> ${orderNumber} — ${t.server}, ${t.table}, ${ticketSum} RWF, ${resolvedItems.length} dish(es)`)
    grandTotal += ticketSum
  }

  console.log(`\nGrand total ${apply ? 'imported' : 'that would be imported'}: ${grandTotal} RWF across ${apply ? orderIds.length + ' new order(s)' : TICKETS.length + ' ticket(s)'}.`)

  // Per-station verification, same shape as the reconciliation check. Only
  // meaningful in apply mode — preview mode wrote nothing to check.
  if (apply && orderIds.length > 0) {
    const start = new Date('2026-07-22T00:00:00+02:00')
    const end = new Date('2026-07-23T00:00:00+02:00')
    const branches = await db.branch.findMany({ where: { restaurantId }, select: { id: true, name: true } })
    console.log('\nPer-station revenue for Jul 22 (journal vs DishSale):')
    for (const b of branches) {
      const je = await db.journalEntry.findMany({ where: { restaurantId, branchId: b.id, entryDate: { gte: start, lt: end }, description: { startsWith: 'DishSale:' } }, select: { lines: { select: { credit: true } } } })
      const j = je.reduce((s, e) => s + e.lines.reduce((s2, l) => s2 + l.credit, 0), 0)
      const ds = await db.dishSale.aggregate({ where: { restaurantId, branchId: b.id, saleDate: { gte: start, lt: end } }, _sum: { totalSaleAmount: true } })
      const d = ds._sum.totalSaleAmount ?? 0
      if (j === 0 && d === 0) continue
      console.log(`   ${b.name.padEnd(16)} journal ${Math.round(j)}  |  dishSale ${Math.round(d)}  ${j === d ? '(match)' : '<-- MISMATCH'}`)
    }
  }

  return orderIds
}

await runImport(prisma)
console.log(apply ? '\nAPPLIED.' : '\nPREVIEW ONLY — nothing was written. Re-run with --apply to commit.')

await prisma.$disconnect()
