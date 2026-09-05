// Changing the taxpayer (§7.2).
//
//   "have reprogrammable TIN under its service mode, for the purpose of
//    ownership transfer, only if the change of TIN is conditioned by the reset
//    which deletes all information saved for previously programmed TIN"
//
// So a TIN cannot simply be edited. It can only change as part of a reset that
// erases everything held under the old one — because otherwise a new owner
// inherits the previous taxpayer's declared sales, and RRA has no way to tell
// whose trade was whose.
//
// §7.3 adds the other half: after a total reset the receipt numbering
// recommences from 1.
//
// PURE. This decides whether a change is allowed and states exactly what would
// be destroyed; performing the erasure is the caller's, inside one transaction.

/** Everything erased when the taxpayer changes. Named, not implied. */
export const TIN_RESET_ERASES = [
  { table: 'fiscal_receipts', description: 'every fiscal receipt issued under the old TIN' },
  { table: 'fiscal_counters', description: 'all receipt numbering, which restarts at 1 (§7.3)' },
  { table: 'cash_movements', description: 'the cash drawer history' },
] as const

export type TinChangeRequest = {
  currentTin?: string | null
  newTin: string
  /** §7.2 — only in service mode. Normal operation cannot reach this. */
  inServiceMode: boolean
  /**
   * Whether the operator has confirmed the erasure. A TIN change is not
   * reversible and takes the venue's whole fiscal history with it, so it takes
   * a deliberate second act, not a saved form.
   */
  resetConfirmed: boolean
  /** The supervisor or owner authorising it. */
  approvedByName?: string | null
}

/** A TIN is nine characters, per the VSDC field definition. */
export function isValidTin(value: unknown): boolean {
  return /^\d{9}$/.test(String(value ?? '').trim())
}

/**
 * Why this TIN change is refused, or null if it may go ahead.
 *
 * Returns the reason rather than throwing so a settings screen can show it
 * beside the field. Each message says which condition failed, because "not
 * allowed" leaves an owner mid-handover with nowhere to go.
 */
export function describeTinChangeRefusal(request: TinChangeRequest): string | null {
  const newTin = String(request.newTin ?? '').trim()
  const currentTin = String(request.currentTin ?? '').trim()

  if (!request.inServiceMode) {
    return 'The TIN can only be changed in service mode'
  }

  if (!isValidTin(newTin)) {
    return 'A TIN must be 9 digits'
  }

  if (currentTin && newTin === currentTin) {
    // Not an error worth a reset. Refusing here prevents an accidental wipe
    // triggered by re-saving a settings form unchanged.
    return 'That is already the current TIN'
  }

  if (!request.resetConfirmed) {
    return 'Changing the TIN erases all fiscal history — confirm the reset first'
  }

  if (!String(request.approvedByName ?? '').trim()) {
    return 'A TIN change must be approved by a named supervisor'
  }

  return null
}

export function canChangeTin(request: TinChangeRequest): boolean {
  return describeTinChangeRefusal(request) === null
}

/**
 * What the operator is about to destroy, in words, for the confirmation screen.
 *
 * Spelled out rather than summarised as "all data": someone transferring
 * ownership should read the list before they agree to it, and a vague warning
 * is one people click through.
 */
export function describeTinResetPlan(request: TinChangeRequest): {
  allowed: boolean
  refusal: string | null
  from: string | null
  to: string
  erases: string[]
  countersRestartAt: number
} {
  const refusal = describeTinChangeRefusal(request)

  return {
    allowed: refusal === null,
    refusal,
    from: String(request.currentTin ?? '').trim() || null,
    to: String(request.newTin ?? '').trim(),
    erases: TIN_RESET_ERASES.map((row) => row.description),
    // §7.3 — numbering recommences from 1 after a total reset.
    countersRestartAt: 1,
  }
}
