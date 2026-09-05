/**
 * The four requirements that were started and needed finishing:
 * the journal (§7.14), refunds (§7.17), closing stock (§7.31).
 */

import { describe, expect, it } from 'vitest'

import { FISCAL_RECEIPT_TYPES } from '@/lib/fiscalCounter'
import { buildJournalEntry, canOperateWithJournal, describeJournalStop } from '@/lib/fiscalJournal'
import { calculateClosingStock } from '@/lib/closingStock'
import {
  REFUND_REASONS,
  RESTAURANT_REFUND_REASONS,
  canRefund,
  describeRefundPlan,
  describeRefundRefusal,
} from '@/lib/vsdc/fiscalRefund'

// ── §7.14 — the journal ─────────────────────────────────────────────────────

describe('§7.14 — the system shall not operate without a journal', () => {
  it('trades when the journal is healthy', () => {
    expect(canOperateWithJournal({ writable: true, unjournalledCount: 0 })).toBe(true)
  })

  it('stops when the journal cannot be written', () => {
    // A stop condition, not a warning. The alternative is printing receipts
    // that nothing records — the exact state the clause prevents.
    expect(canOperateWithJournal({ writable: false })).toBe(false)
    expect(describeJournalStop({ writable: false, lastError: 'disk full' }))
      .toBe('Cannot record sales — disk full')
  })

  it('stops when even one printed receipt is unrecorded', () => {
    const stop = describeJournalStop({ writable: true, unjournalledCount: 1 })

    expect(stop).toContain('not recorded')
    expect(canOperateWithJournal({ writable: true, unjournalledCount: 1 })).toBe(false)
  })

  it('writes the entry as PENDING, before the VSDC has answered', () => {
    // Written before printing on purpose: recording afterwards leaves a window
    // where a crash produces a receipt with no journal entry.
    const entry = buildJournalEntry({
      restaurantId: 'r1',
      branchId: 'b1',
      receiptType: FISCAL_RECEIPT_TYPES.NORMAL_SALE,
      invoiceNumber: 15,
      totalAmount: 5000,
      totalTaxableAmount: 5000,
      totalTaxAmount: 762.71,
      taxByCategory: { B: 762.71 },
      taxableByCategory: { B: 5000 },
      itemCount: 3,
      businessDate: new Date('2026-09-05'),
    })

    expect(entry.status).toBe('PENDING')
    expect(entry.taxAmtB).toBe(762.71)
    expect(entry.taxAmtA).toBe(0)
    expect(entry.itemCount).toBe(3)
  })
})

// ── §7.17 — refunds ─────────────────────────────────────────────────────────

const SALE = {
  receiptType: FISCAL_RECEIPT_TYPES.NORMAL_SALE,
  invoiceNumber: 168,
  totalAmount: 6340,
  status: 'SENT',
  branchId: 'b1',
}

const REQUEST = {
  original: SALE,
  existingRefunds: [],
  reasonCode: REFUND_REASONS.WRONG_ITEMS,
  approvedByName: 'Marie',
  branchId: 'b1',
}

describe('§7.17 — refunds', () => {
  it('allows a valid refund', () => {
    expect(canRefund(REQUEST)).toBe(true)
  })

  it('refuses a second refund on the same bill', () => {
    // The rule that surprises people: once, ever.
    const refusal = describeRefundRefusal({ ...REQUEST, existingRefunds: [{ invoiceNumber: 200 }] })

    expect(refusal).toBe('That bill has already been refunded — a bill can only be refunded once')
  })

  it('refuses anything that is not a normal sale', () => {
    for (const receiptType of [FISCAL_RECEIPT_TYPES.REFUND, FISCAL_RECEIPT_TYPES.COPY, FISCAL_RECEIPT_TYPES.TRAINING]) {
      expect(describeRefundRefusal({ ...REQUEST, original: { ...SALE, receiptType } }))
        .toBe('Only a normal sale can be refunded')
    }
  })

  it('refuses a sale RRA has not received yet', () => {
    // There is nothing on their side to reverse.
    expect(describeRefundRefusal({ ...REQUEST, original: { ...SALE, status: 'PENDING' } }))
      .toContain('has not reached RRA yet')
  })

  it('refuses a receipt from another station', () => {
    expect(describeRefundRefusal({ ...REQUEST, original: { ...SALE, branchId: 'b2' } }))
      .toBe('That receipt belongs to another station')
  })

  it('requires a reason and a named approver', () => {
    expect(describeRefundRefusal({ ...REQUEST, reasonCode: '99' })).toBe('Choose a reason for the refund')
    expect(describeRefundRefusal({ ...REQUEST, approvedByName: ' ' })).toContain('named supervisor')
  })

  it('refuses a receipt that does not exist', () => {
    expect(describeRefundRefusal({ ...REQUEST, original: null })).toBe('That receipt could not be found')
  })

  it('warns out loud that a refund cannot be repeated', () => {
    const plan = describeRefundPlan(REQUEST)

    expect(plan.allowed).toBe(true)
    expect(plan.originalInvoiceNumber).toBe(168)
    expect(plan.amount).toBe(6340)
    expect(plan.reasonLabel).toBe('Wrong item(s)')
    expect(plan.warning).toContain('only be refunded once')
  })

  it('offers a waiter five reasons, not thirteen', () => {
    // The rest are warehouse reasons that mean nothing across a dinner table.
    expect(RESTAURANT_REFUND_REASONS).toHaveLength(5)
    expect(RESTAURANT_REFUND_REASONS).toContain(REFUND_REASONS.WRONG_AMOUNT)
    expect(RESTAURANT_REFUND_REASONS).not.toContain(REFUND_REASONS.RAW_MATERIAL_SHORTAGE)
  })
})

// ── §7.31 — closing stock at a chosen date ──────────────────────────────────

describe('§7.31 — closing stock at a date', () => {
  const current = [
    { inventoryItemId: 'beer', name: 'Mutzig', unit: 'bottle', quantity: 40 },
    { inventoryItemId: 'rice', name: 'Rice', unit: 'kg', quantity: 12 },
  ]

  it('rewinds movements made after the date', () => {
    const result = calculateClosingStock({
      current,
      movementsSince: [
        { inventoryItemId: 'beer', quantity: 24, occurredAt: '2026-09-05T10:00:00Z' },  // received after
        { inventoryItemId: 'beer', quantity: -4, occurredAt: '2026-09-05T20:00:00Z' },  // sold after
        { inventoryItemId: 'rice', quantity: -3, occurredAt: '2026-09-03T10:00:00Z' },  // before — stays
      ],
      asAtEndOf: '2026-09-04T23:59:59Z',
    })

    const beer = result.rows.find((r) => r.inventoryItemId === 'beer')
    // 40 now, less 24 received and plus 4 sold back = 20 on the 4th.
    expect(beer?.quantity).toBe(20)

    const rice = result.rows.find((r) => r.inventoryItemId === 'rice')
    expect(rice?.quantity).toBe(12)
  })

  it('includes movements ON the date asked for', () => {
    // "Closing stock" means after that day's trade, not before it.
    const result = calculateClosingStock({
      current: [{ inventoryItemId: 'beer', name: 'Mutzig', quantity: 40 }],
      movementsSince: [{ inventoryItemId: 'beer', quantity: -6, occurredAt: '2026-09-04T18:00:00Z' }],
      asAtEndOf: '2026-09-04T23:59:59Z',
    })

    expect(result.rows[0].quantity).toBe(40)
  })

  it('returns current stock when nothing has moved', () => {
    const result = calculateClosingStock({ current, movementsSince: [], asAtEndOf: '2026-09-04' })

    expect(result.rows.map((r) => r.quantity)).toEqual([40, 12])
  })

  it('surfaces a negative reconstruction rather than clamping it to zero', () => {
    // A negative closing figure means the movement history and the current
    // count disagree. Hiding it behind a zero presents a broken reconstruction
    // as fact.
    const result = calculateClosingStock({
      current: [{ inventoryItemId: 'beer', name: 'Mutzig', quantity: 5 }],
      movementsSince: [{ inventoryItemId: 'beer', quantity: 30, occurredAt: '2026-09-06T10:00:00Z' }],
      asAtEndOf: '2026-09-05',
    })

    expect(result.rows[0].quantity).toBe(-25)
    expect(result.inconsistent).toHaveLength(1)
  })
})
