/**
 * Backfill (2026-07-14): re-attribute DishSale journal entries to the station
 * that owns each dish. Payment used to post ONE entry under the till's
 * station; DishSale rows (always correctly attributed per dish) are the
 * source of truth. Matching: entry.entryDate === dishSale.saleDate (both were
 * stamped with the same paidAt instant by the payment flow).
 *  - single-station order booked under the wrong station → move the entry
 *  - multi-station order → replace with one entry per station, copying the
 *    original entry's own account lines proportionally (totals preserved)
 * Run with --apply to write; default is a dry-run report.
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

const APPLY = process.argv.includes('--apply')
const REST = 'cmqia7buf0003n5p19gkoov3k'

const branches = await prisma.branch.findMany({ where: { restaurantId: REST }, select: { id: true, name: true } })
const branchName = id => branches.find(b => b.id === id)?.name ?? id

// Only ORIGINAL payment entries carry "[<dishId>]" markers; the per-station
// replacement entries this script creates do not — that keeps re-runs from
// splitting an already-split entry a second time.
const entries = await prisma.journalEntry.findMany({
  where: { restaurantId: REST, deletedAt: null, description: { startsWith: 'DishSale:', contains: '[cm' } },
  include: { lines: true },
  orderBy: { entryDate: 'asc' },
})
console.log(`${entries.length} DishSale journal entries; mode=${APPLY ? 'APPLY' : 'dry-run'}\n`)

let moved = 0, split = 0, ok = 0, unmatched = 0
for (const entry of entries) {
  const sales = await prisma.dishSale.findMany({
    where: { restaurantId: REST, saleDate: entry.entryDate, deletedAt: null },
    select: { branchId: true, totalSaleAmount: true, dishName: true, quantitySold: true },
  })
  if (!sales.length) { unmatched++; continue }

  const byBranch = new Map()
  for (const s of sales) {
    const g = byBranch.get(s.branchId) ?? { amount: 0, names: [] }
    g.amount += s.totalSaleAmount
    g.names.push(`${s.dishName} x${s.quantitySold}`)
    byBranch.set(s.branchId, g)
  }

  if (byBranch.size === 1) {
    const [onlyBranch] = byBranch.keys()
    if (onlyBranch === entry.branchId) { ok++; continue }
    moved++
    console.log(`MOVE  ${entry.entryDate.toISOString().slice(0, 16)} "${(entry.description ?? '').slice(0, 60)}" ${branchName(entry.branchId)} → ${branchName(onlyBranch)}`)
    if (APPLY) {
      await prisma.journalEntry.update({ where: { id: entry.id }, data: { branchId: onlyBranch } })
    }
    continue
  }

  // Multi-station order: split proportionally over the entry's own lines.
  split++
  const totalSaleAmount = [...byBranch.values()].reduce((s, g) => s + g.amount, 0)
  console.log(`SPLIT ${entry.entryDate.toISOString().slice(0, 16)} "${(entry.description ?? '').slice(0, 60)}" ${branchName(entry.branchId)} → ${[...byBranch.entries()].map(([b, g]) => `${branchName(b)}:${g.amount}`).join(' + ')}`)
  if (!APPLY) continue

  await prisma.$transaction(async tx => {
    for (const [groupBranchId, group] of byBranch) {
      const share = totalSaleAmount > 0 ? group.amount / totalSaleAmount : 0
      const suffix = (entry.description ?? '').includes('·') ? ' · ' + entry.description.split('·').pop().trim() : ''
      await tx.journalEntry.create({
        data: {
          restaurantId: REST,
          branchId: groupBranchId,
          description: `DishSale: ${group.names.join(', ')}${suffix}`,
          reference: entry.reference,
          entryDate: entry.entryDate,
          createdAt: entry.createdAt,
          lines: {
            create: entry.lines.map(line => ({
              accountId: line.accountId,
              debit: Math.round(line.debit * share * 100) / 100,
              credit: Math.round(line.credit * share * 100) / 100,
              description: line.description,
            })),
          },
        },
      })
    }
    // Original entry replaced by the per-station copies (lines cascade).
    await tx.journalEntry.delete({ where: { id: entry.id } })
  }, { timeout: 60000, maxWait: 10000 })
}

console.log(`\nCorrect: ${ok}; moved: ${moved}; split: ${split}; unmatched (no sales at timestamp): ${unmatched}`)
await prisma.$disconnect()
