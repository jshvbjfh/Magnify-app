// The electronic journal (§7.14).
//
//   "be equipped with paper journal or electronic journal or the log file which
//    contains all the sales that immediately upon the creation of any printed
//    material are recorded and shall not operate without it"
//
// Two obligations, and the second is the unusual one. The journal must record
// every printed document AS IT IS PRINTED — not afterwards, not on a schedule —
// and the system SHALL NOT OPERATE without it. A till whose journal is
// unwritable has to stop, the same way one that cannot reach the VSDC stops.
//
// The journal itself is the fiscal_receipts table. This is the health check and
// the entry builder around it.
//
// PURE: state is passed in; nothing is read or written.

import type { FiscalReceiptType } from '@/lib/fiscalCounter'

export type JournalHealth = {
  /** Whether the journal store answered its last write or probe. */
  writable: boolean
  /** Receipts printed but not yet journalled. Should always be zero. */
  unjournalledCount?: number
  lastError?: string | null
}

/**
 * Why the till must stop, or null if it may trade.
 *
 * §7.14 makes an unwritable journal a stop condition, not a warning. That reads
 * harsh until you consider what the alternative is: printing receipts that
 * nothing records, which is exactly the state the clause exists to prevent.
 */
export function describeJournalStop(health: JournalHealth): string | null {
  if (!health.writable) {
    const detail = String(health.lastError ?? '').trim()
    return detail
      ? `Cannot record sales — ${detail}`
      : 'Cannot record sales — the journal is unavailable'
  }

  // A receipt on paper with no journal entry behind it is the exact condition
  // §7.14 forbids. One is enough to stop.
  if ((health.unjournalledCount ?? 0) > 0) {
    return `${health.unjournalledCount} printed receipt(s) are not recorded — service cannot continue`
  }

  return null
}

export function canOperateWithJournal(health: JournalHealth): boolean {
  return describeJournalStop(health) === null
}

export type JournalEntryInput = {
  restaurantId: string
  branchId: string
  orderId?: string | null
  receiptType: FiscalReceiptType
  invoiceNumber: number
  originalInvoiceNumber?: number | null
  paymentTypeCode?: string | null
  totalAmount: number
  totalTaxableAmount: number
  totalTaxAmount: number
  taxableByCategory?: Partial<Record<'A' | 'B' | 'C' | 'D', number>>
  taxByCategory?: Partial<Record<'A' | 'B' | 'C' | 'D', number>>
  itemCount?: number
  discountTotal?: number
  businessDate: Date
}

/**
 * The row to write for a receipt, before the VSDC has answered.
 *
 * Written PENDING and BEFORE printing, deliberately. §7.14 wants the record
 * made as the printed material is created; writing afterwards leaves a window
 * where a crash between printing and recording produces exactly the receipt
 * with no journal entry that the clause forbids. Pending-then-confirmed is
 * recoverable; printed-then-lost is not.
 */
export function buildJournalEntry(input: JournalEntryInput) {
  const tax = input.taxByCategory ?? {}
  const taxable = input.taxableByCategory ?? {}

  return {
    restaurantId: input.restaurantId,
    branchId: input.branchId,
    orderId: input.orderId ?? null,
    receiptType: input.receiptType,
    invoiceNumber: input.invoiceNumber,
    originalInvoiceNumber: input.originalInvoiceNumber ?? null,
    paymentTypeCode: input.paymentTypeCode ?? null,
    totalAmount: input.totalAmount,
    totalTaxableAmount: input.totalTaxableAmount,
    totalTaxAmount: input.totalTaxAmount,
    taxableAmtA: taxable.A ?? 0,
    taxableAmtB: taxable.B ?? 0,
    taxableAmtC: taxable.C ?? 0,
    taxableAmtD: taxable.D ?? 0,
    taxAmtA: tax.A ?? 0,
    taxAmtB: tax.B ?? 0,
    taxAmtC: tax.C ?? 0,
    taxAmtD: tax.D ?? 0,
    itemCount: input.itemCount ?? 0,
    discountTotal: input.discountTotal ?? 0,
    status: 'PENDING' as const,
    businessDate: input.businessDate,
  }
}

/** What to write once the VSDC has answered. */
export function buildJournalConfirmation(vsdc: {
  sdcId: string
  sdcDateTime: Date
  receiptNumberForType: number
  receiptNumberTotal: number
  internalData: string
  receiptSignature: string
}) {
  return {
    sdcId: vsdc.sdcId,
    sdcDateTime: vsdc.sdcDateTime,
    receiptNumberForType: vsdc.receiptNumberForType,
    receiptNumberTotal: vsdc.receiptNumberTotal,
    internalData: vsdc.internalData,
    receiptSignature: vsdc.receiptSignature,
    status: 'SENT' as const,
    sentAt: new Date(),
    lastError: null,
  }
}

/** What to write when the VSDC refuses. The receipt must not print (§10). */
export function buildJournalFailure(error: string) {
  return { status: 'FAILED' as const, lastError: String(error).slice(0, 500) }
}
