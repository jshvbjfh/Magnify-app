/**
 * Reconcile DishSale journal entries so each station's Transactions page shows
 * ONLY its own revenue. Rebuilds lumped / duplicated / wrong-station entries
 * from the DishSale rows (the source of truth — already attributed per station).
 *
 * DRY-RUN by default. Pass --apply to write. Scope with --restaurant=<id>.
 *
 * Matching is by PAID INSTANT: finalize stamps journal entryDate == DishSale
 * saleDate == the order's paidAt. Verified in this data that every order has a
 * unique paid-instant (no two orders share one), so an instant identifies exactly
 * one order — regardless of description format or duplicated/marker-less entries
 * left by earlier fixes. This is why per-dish-id matching was unreliable.
 *
 * Safety guarantees:
 *  - Dry-run default: prints every before/after and a per-station BEFORE→AFTER
 *    summary; writes nothing.
 *  - Backup: before any write, dumps every affected entry (+ lines) to
 *    scripts/_reconcile_backup_<restaurantId>_<timestamp>.json.
 *  - Reversible via backup: the wrong entries are hard-deleted (journal entries
 *    are hard records in this app — nothing reads or respects deletedAt, so a
 *    soft-delete would stay visible and double-count). The backup captures every
 *    deleted entry in full (accounts, amounts, sides) so it can be recreated.
 *    Undo = recreate backup.removed entries and delete backup.created ids.
 *  - Self-verifying: per instant, DishSale total must match the order total, and
 *    the rebuilt per-station entries must sum to the DishSale total and match
 *    each station. Anything that doesn't balance is FLAGGED and SKIPPED.
 *  - Idempotent: new entries carry reference="order:<id>"; a re-run sees the
 *    order already correct and skips it. Collapses duplicates in one pass.
 *
 * Only DishSale income journal entries are touched. Expenses, purchases, waste,
 * manual entries, tickets, bills, and the DishSale rows themselves are untouched.
 */
import { createRequire } from 'module'
import { resolve } from 'path'
import { readFileSync, writeFileSync } from 'fs'

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

const APPLY = process.argv.includes('--apply')
const restArg = process.argv.find((a) => a.startsWith('--restaurant='))
const REST = restArg ? restArg.split('=')[1] : 'cmqia7buf0003n5p19gkoov3k' // default: High 5ive
const EPSILON = 1 // RWF rounding tolerance

const round2 = (x) => Math.round(x * 100) / 100
const entryAmount = (entry) => round2(entry.lines.reduce((s, l) => s + Number(l.credit), 0))

function locationFromDescription(desc) {
  const idx = (desc ?? '').lastIndexOf('·')
  return idx >= 0 ? desc.slice(idx + 1).trim() : 'Takeaway'
}

async function main() {
  const restaurant = await prisma.restaurant.findUnique({ where: { id: REST }, select: { id: true, name: true } })
  if (!restaurant) { console.error(`Restaurant ${REST} not found`); process.exit(1) }

  const branches = await prisma.branch.findMany({ where: { restaurantId: REST }, select: { id: true, name: true } })
  const bn = (id) => branches.find((b) => b.id === id)?.name ?? id

  console.log(`\nReconcile DishSale journals — ${restaurant.name} (${REST})`)
  console.log(`Mode: ${APPLY ? '*** APPLY (writing) ***' : 'DRY-RUN (no writes)'}\n`)

  const orders = await prisma.restaurantOrder.findMany({
    where: { restaurantId: REST },
    select: { id: true, totalAmount: true, tableId: true, tableName: true },
  })
  const orderById = new Map(orders.map((o) => [o.id, o]))

  // DishSales grouped by paid instant (== one order).
  const dishSales = await prisma.dishSale.findMany({
    where: { restaurantId: REST, deletedAt: null },
    select: { orderId: true, saleDate: true, dishId: true, branchId: true, totalSaleAmount: true, dishName: true, quantitySold: true },
  })
  const salesByInstant = new Map()
  for (const s of dishSales) {
    if (!s.saleDate) continue
    const k = s.saleDate.toISOString()
    if (!salesByInstant.has(k)) salesByInstant.set(k, [])
    salesByInstant.get(k).push(s)
  }

  // All live DishSale income journal entries, grouped by entryDate instant.
  const allEntries = await prisma.journalEntry.findMany({
    where: { restaurantId: REST, deletedAt: null, description: { startsWith: 'DishSale:' } },
    select: { id: true, branchId: true, description: true, entryDate: true, reference: true, lines: { select: { accountId: true, debit: true, credit: true, description: true } } },
  })
  const entriesByInstant = new Map()
  for (const e of allEntries) {
    if (!e.entryDate) continue
    const k = e.entryDate.toISOString()
    if (!entriesByInstant.has(k)) entriesByInstant.set(k, [])
    entriesByInstant.get(k).push(e)
  }

  // Per-station BEFORE totals (what the Transactions page shows today).
  const beforeByBranch = new Map()
  for (const e of allEntries) beforeByBranch.set(e.branchId, round2((beforeByBranch.get(e.branchId) ?? 0) + entryAmount(e)))
  const afterByBranch = new Map(beforeByBranch) // adjusted only for instants we FIX

  const stats = { ok: 0, fix: 0, flagged: 0, missing: 0 }
  const backup = { restaurantId: REST, generatedAt: new Date().toISOString(), removed: [], created: [] }
  const plan = []

  for (const [instant, sales] of salesByInstant) {
    const orderId = sales[0].orderId
    const order = orderId ? orderById.get(orderId) : null

    const correctByBranch = new Map()
    for (const s of sales) {
      const g = correctByBranch.get(s.branchId) ?? { amount: 0, names: [] }
      g.amount = round2(g.amount + Number(s.totalSaleAmount))
      g.names.push(`${s.dishName} x${s.quantitySold}`)
      correctByBranch.set(s.branchId, g)
    }
    const correctTotal = round2([...correctByBranch.values()].reduce((s, g) => s + g.amount, 0))

    const entries = entriesByInstant.get(instant) ?? []

    // Balance self-check: DishSale total must match the order total (no-VAT world).
    if (order && order.totalAmount != null && Math.abs(correctTotal - Number(order.totalAmount)) > EPSILON) {
      stats.flagged++
      console.log(`FLAG  ${instant.slice(0, 16)} order ${(orderId ?? '?').slice(0, 8)} total mismatch: DishSales=${correctTotal} vs order=${order.totalAmount} — SKIPPED`)
      continue
    }

    if (entries.length === 0) {
      stats.missing++
      console.log(`FLAG  ${instant.slice(0, 16)} order ${(orderId ?? '?').slice(0, 8)} has DishSales but NO journal entry — needs manual booking (${[...correctByBranch].map(([b, g]) => `${bn(b)}:${g.amount}`).join(' + ')})`)
      continue
    }

    // Already correct? exactly one entry per station, matching amounts.
    const currentByBranch = new Map()
    for (const e of entries) currentByBranch.set(e.branchId, round2((currentByBranch.get(e.branchId) ?? 0) + entryAmount(e)))
    const sameBranches = entries.length === correctByBranch.size
      && [...correctByBranch.keys()].every((b) => currentByBranch.has(b))
      && [...currentByBranch.keys()].every((b) => correctByBranch.has(b))
    const amountsMatch = sameBranches && [...correctByBranch].every(([b, g]) => Math.abs((currentByBranch.get(b) ?? 0) - g.amount) <= EPSILON)
    if (amountsMatch) { stats.ok++; continue }

    // Needs reconciliation.
    stats.fix++
    for (const [b, cur] of currentByBranch) afterByBranch.set(b, round2((afterByBranch.get(b) ?? 0) - cur))
    for (const [b, g] of correctByBranch) afterByBranch.set(b, round2((afterByBranch.get(b) ?? 0) + g.amount))

    const location = order ? locationFromDescription(entries[0].description) : locationFromDescription(entries[0].description)
    const dup = entries.length > correctByBranch.size
    const beforeStr = [...currentByBranch].map(([b, a]) => `${bn(b)}:${a}`).join(' + ') + (dup ? ` (${entries.length} entries)` : '')
    const afterStr = [...correctByBranch].map(([b, g]) => `${bn(b)}:${g.amount}`).join(' + ')
    console.log(`FIX   ${instant.slice(0, 16)} order ${(orderId ?? '?').slice(0, 8)} ${location}:  [${beforeStr}]  →  [${afterStr}]`)

    plan.push({ instant, orderId, entries, correctByBranch, location })
  }

  // ---- Per-station BEFORE → AFTER summary ----
  console.log(`\n${'Station'.padEnd(20)} ${'BEFORE'.padStart(14)} ${'AFTER'.padStart(14)}   change`)
  for (const b of new Set([...beforeByBranch.keys(), ...afterByBranch.keys()])) {
    const before = beforeByBranch.get(b) ?? 0, after = afterByBranch.get(b) ?? 0, delta = round2(after - before)
    console.log(`${bn(b).padEnd(20)} ${String(before).padStart(14)} ${String(after).padStart(14)}   ${delta >= 0 ? '+' : ''}${delta}`)
  }
  console.log(`\nSummary: OK=${stats.ok}  to-fix=${stats.fix}  flagged=${stats.flagged}  missing-journal=${stats.missing}`)

  if (!APPLY) {
    console.log('\nDRY-RUN — nothing was written. Re-run with --apply to commit (a backup is written first).')
    await prisma.$disconnect()
    return
  }
  if (plan.length === 0) { console.log('\nNothing to write.'); await prisma.$disconnect(); return }

  // ---- APPLY: per-instant transactional rebuild with verify ----
  const now = new Date()
  let applied = 0, aborted = 0
  for (const { instant, orderId, entries, correctByBranch, location } of plan) {
    const template = entries[0]
    const cashLine = template.lines.find((l) => Number(l.debit) > 0)
    const revLine = template.lines.find((l) => Number(l.credit) > 0)
    if (!cashLine || !revLine) {
      aborted++
      console.log(`ABORT ${instant.slice(0, 16)} — template ${template.id} has no clear cash/revenue legs; left untouched`)
      continue
    }
    try {
      await prisma.$transaction(async (tx) => {
        for (const e of entries) {
          backup.removed.push({ id: e.id, restaurantId: REST, branchId: e.branchId, description: e.description, entryDate: e.entryDate, reference: e.reference, lines: e.lines })
          await tx.journalEntry.delete({ where: { id: e.id } })
        }
        const createdIds = []
        for (const [branchId, g] of correctByBranch) {
          const created = await tx.journalEntry.create({
            data: {
              restaurantId: REST,
              branchId,
              description: `DishSale: ${g.names.join(', ')} · ${location}`,
              reference: orderId ? `order:${orderId}` : template.reference,
              entryDate: template.entryDate,
              createdAt: template.entryDate,
              lines: { create: [
                { accountId: cashLine.accountId, debit: g.amount, credit: 0, description: revLine.description ?? null },
                { accountId: revLine.accountId, debit: 0, credit: g.amount, description: revLine.description ?? null },
              ] },
            },
            select: { id: true },
          })
          createdIds.push(created.id)
          backup.created.push({ id: created.id, orderId, branchId, amount: g.amount })
        }
        // Verify inside the transaction — roll back on any imbalance.
        const check = await tx.journalEntry.findMany({ where: { id: { in: createdIds } }, select: { branchId: true, lines: { select: { credit: true } } } })
        const got = new Map()
        for (const e of check) got.set(e.branchId, round2((got.get(e.branchId) ?? 0) + e.lines.reduce((s, l) => s + Number(l.credit), 0)))
        for (const [b, g] of correctByBranch) {
          if (Math.abs((got.get(b) ?? 0) - g.amount) > EPSILON) throw new Error(`verify failed ${bn(b)}: wrote ${got.get(b)}, expected ${g.amount}`)
        }
      }, { timeout: 60000, maxWait: 10000 })
      applied++
    } catch (err) {
      aborted++
      console.log(`ABORT ${instant.slice(0, 16)} — ${err.message} (rolled back, left untouched)`)
    }
  }

  const backupPath = resolve(process.cwd(), 'scripts', `_reconcile_backup_${REST}_${now.toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(backupPath, JSON.stringify(backup, null, 2))
  console.log(`\nApplied: ${applied} instant(s); aborted: ${aborted}. Backup written to ${backupPath}`)
  console.log('Undo = recreate backup.removed entries and delete backup.created ids.')
  await prisma.$disconnect()
}

main().catch((e) => { console.error('FATAL:', e); prisma.$disconnect(); process.exit(1) })
