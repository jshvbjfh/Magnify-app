// Closing stock at a date the user chooses (§7.31).
//
//   "be able to provide a closing stock of a given date by user"
//
// Not "current stock" — stock AS AT a past date. An auditor asks what was on
// the shelf on the 14th, and the answer has to be reconstructible months later.
//
// Reconstructed by rewinding: take what is on hand now and undo every movement
// recorded since the date asked for. That is the only method that stays correct
// when stock has moved in the meantime, which it always has.
//
// PURE. Current quantities and the movements since are passed in.

import { round2 } from '@/lib/restaurantVat'

/**
 * A movement, signed by its effect on stock.
 *
 * Positive added to the shelf, negative took away. Unlike cash movements, the
 * sign lives on the quantity here because the caller reads these from several
 * different tables — purchases, sales, waste, adjustments — and normalising
 * them to one signed number at the boundary is simpler than carrying six kinds
 * through the arithmetic.
 */
export type StockMovement = {
  inventoryItemId: string
  /** Positive = in, negative = out. */
  quantity: number
  occurredAt: Date | string
}

export type CurrentStock = {
  inventoryItemId: string
  name: string
  unit?: string | null
  quantity: number
}

function time(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime()
}

/**
 * What was on the shelf at the end of the given date.
 *
 * `asAtEndOf` is inclusive: asking for the 14th includes everything that
 * happened ON the 14th. That is what "closing stock" means to anyone who has
 * counted a store — the figure after the day's trade, not before it.
 */
export function calculateClosingStock(input: {
  current: CurrentStock[]
  movementsSince: StockMovement[]
  asAtEndOf: Date | string
}) {
  const cutoff = time(input.asAtEndOf)

  // Everything AFTER the cutoff gets undone. A movement exactly at the cutoff
  // instant counts as within the day and stays.
  const toUndo = new Map<string, number>()

  for (const movement of input.movementsSince ?? []) {
    const at = time(movement.occurredAt)
    if (!Number.isFinite(at) || at <= cutoff) continue

    const quantity = Number(movement.quantity)
    if (!Number.isFinite(quantity)) continue

    toUndo.set(movement.inventoryItemId, round2((toUndo.get(movement.inventoryItemId) ?? 0) + quantity))
  }

  const rows = (input.current ?? []).map((item) => {
    const since = toUndo.get(item.inventoryItemId) ?? 0
    // Rewind: subtract everything that happened after the date.
    const quantity = round2(Number(item.quantity) - since)

    return {
      inventoryItemId: item.inventoryItemId,
      name: item.name,
      unit: item.unit ?? null,
      quantity,
      currentQuantity: round2(Number(item.quantity)),
      movedSince: since,
    }
  })

  return {
    asAtEndOf: input.asAtEndOf,
    rows,
    /**
     * Items whose reconstructed quantity is negative.
     *
     * Surfaced rather than clamped to zero. A negative closing figure means the
     * movement history and the current count disagree — stock sold that was
     * never received, or a count corrected without a movement — and hiding it
     * behind a zero would present a broken reconstruction as fact.
     */
    inconsistent: rows.filter((row) => row.quantity < 0),
  }
}
