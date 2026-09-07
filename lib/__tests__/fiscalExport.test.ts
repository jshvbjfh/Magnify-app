import { describe, it, expect } from 'vitest'
import { buildFiscalExport, exportDigestMatches } from '@/lib/fiscalExport'

const base = {
  tin: '149047989',
  branchId: 'branch-1',
  mrc: 'MRC001',
  receipts: [{ invoiceNumber: 1, totalAmount: 6340, issuedAt: new Date('2026-09-08T10:00:00.000Z') }],
  counters: [{ receiptType: 'NS', nextValue: 2 }],
  cashMovements: [{ kind: 'OPENING_FLOAT', amount: 50000 }],
}

describe('the export digest', () => {
  it('is stable when nothing has changed', () => {
    // Taken twice with no trade in between, it must agree — otherwise it could
    // never be sent back in time to authorise anything.
    const first = buildFiscalExport(base, new Date('2026-09-08T10:00:00.000Z'))
    const second = buildFiscalExport(base, new Date('2026-09-08T18:30:00.000Z'))
    expect(second.digest).toBe(first.digest)
  })

  it('does not depend on the order the columns arrived in', () => {
    const reordered = buildFiscalExport({
      ...base,
      receipts: [{ issuedAt: new Date('2026-09-08T10:00:00.000Z'), totalAmount: 6340, invoiceNumber: 1 }],
    })
    expect(reordered.digest).toBe(buildFiscalExport(base).digest)
  })

  it('changes when one more receipt has been issued', () => {
    // The whole point: an export taken before last week's trading must not
    // authorise erasing that week.
    const after = buildFiscalExport({
      ...base,
      receipts: [...base.receipts, { invoiceNumber: 2, totalAmount: 1000, issuedAt: new Date() }],
    })
    expect(after.digest).not.toBe(buildFiscalExport(base).digest)
  })

  it('changes when an amount is altered', () => {
    const altered = buildFiscalExport({
      ...base,
      receipts: [{ ...base.receipts[0], totalAmount: 6341 }],
    })
    expect(altered.digest).not.toBe(buildFiscalExport(base).digest)
  })

  it('counts what it contains', () => {
    const exported = buildFiscalExport(base)
    expect(exported.counts).toEqual({ receipts: 1, counters: 1, cashMovements: 1 })
  })
})

describe('exportDigestMatches', () => {
  const digest = buildFiscalExport(base).digest

  it('accepts the digest of the current records', () => {
    expect(exportDigestMatches(digest, digest)).toBe(true)
  })

  it('ignores case, since a digest may be retyped', () => {
    expect(exportDigestMatches(digest, digest.toUpperCase())).toBe(true)
  })

  it('refuses anything that is not a digest', () => {
    // A boolean the caller typed is exactly what this exists to reject.
    expect(exportDigestMatches(digest, true)).toBe(false)
    expect(exportDigestMatches(digest, '')).toBe(false)
    expect(exportDigestMatches(digest, null)).toBe(false)
    expect(exportDigestMatches(digest, 'yes')).toBe(false)
  })

  it('refuses a digest of the wrong length even if it prefixes correctly', () => {
    expect(exportDigestMatches(digest, digest.slice(0, 63))).toBe(false)
  })
})
