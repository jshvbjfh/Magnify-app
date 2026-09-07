// Exporting the fiscal records, and proving a copy was taken.
//
// The §7.2 TIN reset destroys every fiscal record held under the old taxpayer.
// The undertaking given to RRA says those records are not removable by any
// function available to a user, and the two only reconcile if nothing is
// destroyed that has not first been preserved in the taxpayer's own hands.
//
// ── Why a digest, and not a checkbox ────────────────────────────────────────
//
// `recordsExported: true` sent by a client proves nothing — it is a boolean
// somebody typed. So the export carries a digest of exactly what it contains,
// and the reset will not run unless the caller sends that digest back AND it
// still matches the records currently in the database.
//
// That single check establishes both halves: the caller holds a copy, and the
// copy is of the records about to be erased rather than of an older export
// taken before the last week of trading.
//
// PURE: rows in, a stable document and its digest out. Nothing is read.

import { createHash } from 'node:crypto'

export type ExportableReceipt = Record<string, unknown>

export type FiscalExportInput = {
  tin: string | null
  branchId: string
  mrc: string | null
  receipts: ExportableReceipt[]
  counters: Array<{ receiptType: string; nextValue: number }>
  cashMovements: Array<Record<string, unknown>>
}

/**
 * Dates and Decimals do not stringify the same way twice across drivers, and a
 * digest that changes without the data changing would block a legitimate reset.
 * Everything is flattened to a primitive before hashing.
 */
function stable(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(stable)
  if (typeof value === 'object') {
    // Key order must not depend on the order Prisma happened to return columns.
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return Object.fromEntries(entries.map(([key, entry]) => [key, stable(entry)]))
  }
  if (typeof value === 'bigint') return value.toString()
  return value
}

/**
 * The export document and its digest.
 *
 * The digest covers the records only — not the timestamp — so taking the export
 * twice with nothing traded in between yields the same digest. A digest that
 * moved every second could never be sent back in time to authorise anything.
 */
export function buildFiscalExport(input: FiscalExportInput, generatedAt: Date = new Date()) {
  const records = stable({
    tin: input.tin,
    branchId: input.branchId,
    mrc: input.mrc,
    receipts: input.receipts,
    counters: input.counters,
    cashMovements: input.cashMovements,
  })

  const digest = createHash('sha256').update(JSON.stringify(records)).digest('hex')

  return {
    generatedAt: generatedAt.toISOString(),
    counts: {
      receipts: input.receipts.length,
      counters: input.counters.length,
      cashMovements: input.cashMovements.length,
    },
    digest,
    records,
  }
}

/** Whether the caller's digest matches the records as they stand now. */
export function exportDigestMatches(current: string, claimed: unknown): boolean {
  const supplied = String(claimed ?? '').trim().toLowerCase()
  return supplied.length === 64 && supplied === current.toLowerCase()
}
