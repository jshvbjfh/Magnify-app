// Refunds (§7.17).
//
//   "not be able to correct a transaction without prior cancelation of the
//    original transaction. Each cancelation must refer to the original
//    erroneous SDC Receipt number. Moreover, an original transaction is allowed
//    to be cancel only once"
//
// Three rules in one sentence, and the third is the one that surprises people:
// a bill can be refunded ONCE, ever. Refund half of it and the other half can
// never be refunded. Staff have to know that before they press the button,
// which is why the refusal messages below say it plainly.
//
// PURE. The original receipt and any existing refunds are passed in; nothing is
// read or written.

import { round2 } from '@/lib/restaurantVat'
import { FISCAL_RECEIPT_TYPES, type FiscalReceiptType } from '@/lib/fiscalCounter'

/** §4.16 Refund Reason Code, from the VSDC specification. */
export const REFUND_REASONS = {
  MISSING_QUANTITY: '01',
  MISSING_ITEM: '02',
  DAMAGED: '03',
  WASTED: '04',
  RAW_MATERIAL_SHORTAGE: '05',
  REFUND: '06',
  WRONG_CUSTOMER_TIN: '07',
  WRONG_CUSTOMER_NAME: '08',
  WRONG_AMOUNT: '09',
  WRONG_QUANTITY: '10',
  WRONG_ITEMS: '11',
  WRONG_TAX_TYPE: '12',
  OTHER: '13',
} as const

export type RefundReasonCode = (typeof REFUND_REASONS)[keyof typeof REFUND_REASONS]

export const REFUND_REASON_LABELS: Record<string, string> = {
  '01': 'Missing quantity',
  '02': 'Missing item',
  '03': 'Damaged',
  '04': 'Wasted',
  '05': 'Raw material shortage',
  '06': 'Refund',
  '07': 'Wrong customer TIN',
  '08': 'Wrong customer name',
  '09': 'Wrong amount or price',
  '10': 'Wrong quantity',
  '11': 'Wrong item(s)',
  '12': 'Wrong tax type',
  '13': 'Other reason',
}

/**
 * The five a waiter is offered, out of the thirteen RRA defines.
 *
 * The rest are warehouse reasons — raw material shortage, wasted — that mean
 * nothing across a dinner table. A waiter scrolling thirteen options with a
 * guest waiting is friction we can remove without losing anything: the full set
 * stays available to a manager.
 */
export const RESTAURANT_REFUND_REASONS: RefundReasonCode[] = [
  REFUND_REASONS.WRONG_AMOUNT,
  REFUND_REASONS.WRONG_QUANTITY,
  REFUND_REASONS.WRONG_ITEMS,
  REFUND_REASONS.REFUND,
  REFUND_REASONS.OTHER,
]

export function isValidRefundReason(code: unknown): boolean {
  return Object.hasOwn(REFUND_REASON_LABELS, String(code ?? '').trim())
}

/** The receipt being reversed, as this needs to see it. */
export type OriginalReceipt = {
  receiptType: FiscalReceiptType
  invoiceNumber: number
  totalAmount: number
  /** PENDING · SENT · FAILED. */
  status: string
  branchId: string
}

export type RefundRequest = {
  original: OriginalReceipt | null | undefined
  /**
   * Refunds already issued against this original. §7.17 allows exactly one,
   * so anything in here refuses the request.
   */
  existingRefunds: Array<{ invoiceNumber: number }>
  reasonCode: string
  approvedByName?: string | null
  /** Refunding onto a different outlet's receipt would corrupt both sequences. */
  branchId: string
}

/**
 * Why this refund is refused, or null if it may go ahead.
 *
 * Messages are one line and say what happened rather than what rule failed —
 * they are read mid-service by someone standing with a guest.
 */
export function describeRefundRefusal(request: RefundRequest): string | null {
  const original = request.original

  if (!original) {
    return 'That receipt could not be found'
  }

  if (original.branchId !== request.branchId) {
    return 'That receipt belongs to another station'
  }

  // Only a sale can be reversed. Refunding a refund, a copy or a training
  // ticket is meaningless and would corrupt the sequence.
  if (original.receiptType !== FISCAL_RECEIPT_TYPES.NORMAL_SALE) {
    return 'Only a normal sale can be refunded'
  }

  // A sale RRA never received cannot be reversed — there is nothing on their
  // side to reverse. It has to transmit first.
  if (String(original.status).toUpperCase() !== 'SENT') {
    return 'That sale has not reached RRA yet — it cannot be refunded until it does'
  }

  // §7.17 — once, ever.
  if ((request.existingRefunds ?? []).length > 0) {
    return 'That bill has already been refunded — a bill can only be refunded once'
  }

  if (!isValidRefundReason(request.reasonCode)) {
    return 'Choose a reason for the refund'
  }

  if (!String(request.approvedByName ?? '').trim()) {
    return 'A refund must be approved by a named supervisor'
  }

  return null
}

export function canRefund(request: RefundRequest): boolean {
  return describeRefundRefusal(request) === null
}

/**
 * What the refund will look like, for the confirmation screen.
 *
 * Says the amount and states the once-only rule out loud, because a supervisor
 * approving a partial refund needs to know the rest can never be recovered.
 */
export function describeRefundPlan(request: RefundRequest) {
  const refusal = describeRefundRefusal(request)
  const original = request.original

  return {
    allowed: refusal === null,
    refusal,
    originalInvoiceNumber: original?.invoiceNumber ?? null,
    amount: round2(Number(original?.totalAmount ?? 0)),
    reasonCode: String(request.reasonCode ?? '').trim() || null,
    reasonLabel: REFUND_REASON_LABELS[String(request.reasonCode ?? '').trim()] ?? null,
    warning: 'A bill can only be refunded once — this cannot be undone or repeated',
  }
}
