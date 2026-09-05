// The cash drawer (§7.12).
//
// RRA requires a certified system to register cash deposits and withdrawals,
// and the daily report to state the opening deposit (§18.1.12). This is the
// arithmetic for both, plus the figure a manager actually wants at close: what
// SHOULD be in the drawer.
//
// PURE. Movements and cash takings are passed in; nothing is read or written.

import { round2 } from '@/lib/restaurantVat'

export const CASH_MOVEMENT_KINDS = {
  /** Counted into the till before service. */
  OPENING_FLOAT: 'OPENING_FLOAT',
  /** Cash added mid-service — a change run, a correction upward. */
  DEPOSIT: 'DEPOSIT',
  /** Cash taken out — a drop to the safe, a payout at the door. */
  WITHDRAWAL: 'WITHDRAWAL',
} as const

export type CashMovementKind = (typeof CASH_MOVEMENT_KINDS)[keyof typeof CASH_MOVEMENT_KINDS]

export type CashMovementInput = {
  kind: string
  /** Always positive. `kind` carries the direction. */
  amount: number
}

/** Whether taking this money out needs a supervisor's approval. */
export function requiresApproval(kind: string): boolean {
  return normalizeKind(kind) === CASH_MOVEMENT_KINDS.WITHDRAWAL
}

function normalizeKind(value: unknown): string {
  return String(value ?? '').trim().toUpperCase()
}

/** Discards a sign, a NaN or a string that arrived from a device. */
function positiveAmount(value: unknown): number {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return 0
  // Negative is meaningless here — the direction is the kind's job. Taking the
  // magnitude means a mis-signed entry still moves cash the way its kind says,
  // rather than silently reversing it.
  return round2(Math.abs(amount))
}

/**
 * What the drawer holds, and what it should hold.
 *
 * `cashSales` and `cashRefunds` are the cash-tendered totals for the period —
 * card and mobile money never touch the drawer and must not be counted here.
 * That is the mistake worth naming: including every sale makes the expected
 * figure wrong by exactly the amount that went through the card machine, and it
 * looks like theft.
 */
export function summarizeCashDrawer(input: {
  movements: CashMovementInput[]
  cashSales?: number
  cashRefunds?: number
}) {
  let openingFloat = 0
  let deposits = 0
  let withdrawals = 0
  /**
   * Anything whose kind we do not recognise, surfaced rather than swallowed.
   * A typo in a kind would otherwise drop money out of the drawer total with
   * nothing to show for it, which is the worst way for a cash figure to be
   * wrong: quietly.
   */
  const unrecognised: CashMovementInput[] = []

  for (const movement of input.movements ?? []) {
    const amount = positiveAmount(movement.amount)

    switch (normalizeKind(movement.kind)) {
      // Summed, not "the first one wins". A float counted wrong is corrected by
      // adding a second row, so the total has to include both.
      case CASH_MOVEMENT_KINDS.OPENING_FLOAT:
        openingFloat = round2(openingFloat + amount)
        break
      case CASH_MOVEMENT_KINDS.DEPOSIT:
        deposits = round2(deposits + amount)
        break
      case CASH_MOVEMENT_KINDS.WITHDRAWAL:
        withdrawals = round2(withdrawals + amount)
        break
      default:
        unrecognised.push(movement)
    }
  }

  const cashSales = round2(Number(input.cashSales ?? 0))
  const cashRefunds = round2(Number(input.cashRefunds ?? 0))

  return {
    openingFloat,
    deposits,
    withdrawals,
    cashSales,
    cashRefunds,
    unrecognised,
    /** What a manager should count at close, if nothing has gone astray. */
    expectedInDrawer: round2(openingFloat + deposits + cashSales - withdrawals - cashRefunds),
  }
}

/**
 * The difference between what was counted and what was expected.
 *
 * Positive means the drawer is over, negative means short. Returned as a number
 * rather than a verdict on purpose: whether a 200 Rwf discrepancy matters is a
 * question for the venue, not for this function.
 */
export function cashVariance(counted: number, expected: number): number {
  return round2(Number(counted) - Number(expected))
}
