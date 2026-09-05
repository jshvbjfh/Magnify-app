// Recovering an interrupted print (§7.28).
//
//   "continue or re-print last line in the case of power failure or after
//    missing paper recovery"
//
// A receipt half-printed when the paper ran out is a compliance problem, not a
// stationery one: the guest has no receipt, and §7.18 says only ONE original
// may ever print. So recovery has to resume the same receipt rather than issue
// a fresh one — a second original would be a second receipt for one sale.
//
// PURE. Tracks what was being printed and decides what to do next; the caller
// owns the printer.

export const PRINT_JOB_STATES = {
  PENDING: 'PENDING',
  PRINTING: 'PRINTING',
  /** Stopped part-way — paper out, power cut, printer offline. */
  INTERRUPTED: 'INTERRUPTED',
  COMPLETED: 'COMPLETED',
} as const

export type PrintJobState = (typeof PRINT_JOB_STATES)[keyof typeof PRINT_JOB_STATES]

export type PrintJob = {
  id: string
  /** The fiscal receipt this belongs to, so recovery reprints the same one. */
  fiscalReceiptId: string | null
  state: PrintJobState
  /** Total lines in the receipt. */
  totalLines: number
  /** How many the printer confirmed. */
  linesPrinted: number
  /** Whether an original has ever completed for this receipt (§7.18). */
  originalCompleted: boolean
}

export type RecoveryAction =
  /** Nothing was interrupted. */
  | { action: 'none' }
  /** Resume the same original from where it stopped. */
  | { action: 'continue'; fromLine: number; message: string }
  /**
   * Start the same original again. Used when the printer cannot be told to
   * resume mid-receipt — most thermal printers cannot — and no original has
   * completed, so re-issuing one is still the FIRST original, not a second.
   */
  | { action: 'reprint-original'; message: string }
  /**
   * An original already completed, so anything further must be a marked COPY
   * (§7.18). This is the case that must never silently print another original.
   */
  | { action: 'reprint-as-copy'; message: string }

/**
 * What to do with an interrupted job.
 *
 * The distinction that matters is whether an original ever finished. If it did,
 * the guest has their receipt and any further paper is a copy — printing a
 * second original would put two receipts into the world for one sale, which is
 * exactly what §7.18 forbids.
 */
export function planPrintRecovery(job: PrintJob | null | undefined): RecoveryAction {
  if (!job) return { action: 'none' }
  if (job.state !== PRINT_JOB_STATES.INTERRUPTED) return { action: 'none' }

  if (job.originalCompleted) {
    return {
      action: 'reprint-as-copy',
      message: 'The original already printed — this will print as a COPY',
    }
  }

  const printed = Math.max(0, Math.floor(Number(job.linesPrinted) || 0))
  const total = Math.max(0, Math.floor(Number(job.totalLines) || 0))

  // Nothing reached the paper, so there is no partial receipt in anyone's hand.
  // Starting again is cleaner than resuming from line zero.
  if (printed <= 0) {
    return { action: 'reprint-original', message: 'Printing was interrupted — reprinting the receipt' }
  }

  // Everything printed but the job was never confirmed — treat it as done
  // rather than printing a duplicate on a confirmation that got lost.
  if (total > 0 && printed >= total) {
    return { action: 'none' }
  }

  return {
    action: 'continue',
    fromLine: printed,
    message: `Printing resumed from line ${printed + 1} of ${total}`,
  }
}

/** Whether an interrupted job blocks further trade (§7.28 read with §7.15). */
export function blocksFurtherSales(job: PrintJob | null | undefined): boolean {
  // A sale whose receipt never completed has been registered without a receipt,
  // which §7.15 forbids. Service should stop until it is resolved — not because
  // the printer is broken, but because the sale is not lawfully recorded yet.
  return Boolean(job && job.state === PRINT_JOB_STATES.INTERRUPTED && !job.originalCompleted)
}
