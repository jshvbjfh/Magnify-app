// Once a bill is settled under RRA fiscal mode, it is finished.
//
// A settled bill has been declared to RRA: it carries a receipt number from a
// gap-free sequence, a signature, and the guest has the paper. Cancelling or
// deleting it would leave a hole in a sequence RRA audits precisely for holes,
// and would contradict a receipt already in someone's pocket.
//
// The CIS specification is explicit: a transaction may not be corrected without
// prior cancellation of the original, each cancellation must reference the
// original receipt number, and an original may be cancelled only ONCE (§7.17).
// The mechanism for undoing a settled sale is a refund receipt (NR) that points
// at the original — not the disappearance of the original.
//
// Outside fiscal mode nothing here applies, and every venue keeps the behaviour
// it has today.

/** Statuses that mean money has been taken and the sale declared. */
const SETTLED_STATUSES = new Set(['PAID'])

export function isSettledOrderStatus(status: string | null | undefined): boolean {
  return SETTLED_STATUSES.has(String(status ?? '').trim().toUpperCase())
}

/**
 * Why this settled order may not be voided, or null if it may.
 *
 * Returns the message rather than throwing so each caller can answer in its own
 * shape — an HTTP 409, a till toast — without unwrapping an error. The message
 * is one line and says what to do instead, because it is read by a waiter
 * mid-service who needs the next step, not an explanation of tax law.
 */
export function describeFiscalVoidRefusal(params: {
  fiscalMode: boolean
  status: string | null | undefined
  action: 'cancel' | 'delete'
}): string | null {
  if (!params.fiscalMode) return null
  if (!isSettledOrderStatus(params.status)) return null

  return params.action === 'cancel'
    ? "Settled bills can't be canceled — issue a refund instead"
    : "Settled bills can't be deleted — issue a refund instead"
}

/** Whether a settled order may be voided at all. */
export function canVoidSettledOrder(params: {
  fiscalMode: boolean
  status: string | null | undefined
  action: 'cancel' | 'delete'
}): boolean {
  return describeFiscalVoidRefusal(params) === null
}
