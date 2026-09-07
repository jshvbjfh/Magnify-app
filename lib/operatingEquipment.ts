// Operating equipment — the arithmetic behind a stock movement.
//
// Pulled out of the route so the rules that decide a stock level are testable
// on their own. Everything here is pure: no Prisma, no session, no I/O.

export const MOVEMENT_KINDS = ['purchase', 'issue', 'adjustment'] as const
export type MovementKind = (typeof MOVEMENT_KINDS)[number]

export function isMovementKind(value: unknown): value is MovementKind {
  return typeof value === 'string' && (MOVEMENT_KINDS as readonly string[]).includes(value)
}

/**
 * Turn what the screen collected into the signed delta that gets stored.
 *
 * The form asks "how many did you receive / hand out" — a plain count, never a
 * delta — so purchase and issue supply the sign themselves and a typed minus is
 * ignored rather than silently doubling back on itself. An adjustment is the one
 * case where direction is the user's to state, because a stock take corrects
 * upwards as often as down.
 */
export function signedMovementQuantity(kind: MovementKind, raw: number): number {
  if (kind === 'purchase') return Math.abs(raw)
  if (kind === 'issue') return -Math.abs(raw)
  return raw
}

export type MovementOutcome =
  | { ok: true; delta: number; nextQuantity: number }
  | { ok: false; error: string }

/**
 * Apply a movement to a stock level, refusing the ones that make it meaningless.
 *
 * Negative stock is always a recording error rather than a real state — you
 * cannot hand out soap you do not have — and letting it through means the number
 * on the shelf and the number on screen part company with no way back. A
 * correction is the tool for a count that is already wrong.
 */
export function applyMovement(params: {
  kind: MovementKind
  rawQuantity: number
  currentQuantity: number
  unit: string
}): MovementOutcome {
  const { kind, rawQuantity, currentQuantity, unit } = params

  if (!Number.isFinite(rawQuantity) || rawQuantity === 0) {
    return { ok: false, error: 'Enter a quantity' }
  }

  const delta = signedMovementQuantity(kind, rawQuantity)
  const nextQuantity = currentQuantity + delta

  if (nextQuantity < 0) {
    return { ok: false, error: `Only ${currentQuantity} ${unit} on hand` }
  }

  return { ok: true, delta, nextQuantity }
}

/**
 * What one unit costs after this movement.
 *
 * Only a purchase carries price information. An issue or a correction says
 * nothing about what the next bar of soap will cost, so they leave the figure
 * alone rather than resetting it to whatever the form happened to submit.
 */
export function nextUnitCost(params: {
  kind: MovementKind
  submittedUnitCost: number | null
  currentUnitCost: number
}): number {
  const { kind, submittedUnitCost, currentUnitCost } = params
  if (kind !== 'purchase') return currentUnitCost
  if (submittedUnitCost === null || !Number.isFinite(submittedUnitCost) || submittedUnitCost <= 0) {
    return currentUnitCost
  }
  return submittedUnitCost
}
