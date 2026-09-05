// Refusing a sale when the stock is not there (§7.30).
//
//   "not issue a receipt of goods when the corresponding stock is less than the
//    requested quantity. However, CIS can issue a receipt for service item
//    regardless the stock."
//
// Two halves, and the second matters as much as the first. A restaurant sells
// mostly SERVICE items — a plate cooked to order, whose ingredients are tracked
// but which is not itself a counted thing. Blocking those would stop service
// every time a recipe was incomplete, which is not what the clause asks for.
//
// PURE. Availability is passed in; nothing is read.

import { round2 } from '@/lib/restaurantVat'

export const ITEM_TYPES = {
  /** Bought and resold as it is — a bottle, a packet. Stock is countable. */
  GOODS: 'GOODS',
  /** Prepared or performed. Exempt from the stock check by §7.30. */
  SERVICE: 'SERVICE',
} as const

export type ItemType = (typeof ITEM_TYPES)[keyof typeof ITEM_TYPES]

/** Anything not explicitly marked GOODS is a service — see the note on Dish.itemType. */
export function normalizeItemType(value: unknown): ItemType {
  return String(value ?? '').trim().toUpperCase() === ITEM_TYPES.GOODS
    ? ITEM_TYPES.GOODS
    : ITEM_TYPES.SERVICE
}

export type StockGuardLine = {
  itemCode?: string | null
  name: string
  qty: number
  itemType?: string | null
  /**
   * How many are on hand. Undefined means unknown — NOT zero.
   *
   * The difference decides whether service continues: an item whose stock has
   * never been counted must not be treated as out of stock, or a venue that has
   * not finished its inventory cannot sell anything.
   */
  available?: number | null
}

export type StockRefusal = {
  name: string
  itemCode: string | null
  requested: number
  available: number
}

/**
 * Which lines may not be sold.
 *
 * Returns the refusals rather than throwing, so the caller can name every
 * blocked item at once. A waiter told "something is out of stock" has to guess;
 * a waiter told which two dishes are short can fix the order in one go.
 */
export function checkFiscalStock(lines: StockGuardLine[]): StockRefusal[] {
  const refusals: StockRefusal[] = []

  for (const line of lines ?? []) {
    // §7.30 — services are exempt whatever the stock says.
    if (normalizeItemType(line.itemType) !== ITEM_TYPES.GOODS) continue

    // Unknown availability is not zero. Blocking on "we have never counted
    // this" would stop a venue trading over a gap in its own records, which is
    // not what the clause protects against.
    if (line.available === null || line.available === undefined) continue

    const available = round2(Number(line.available))
    const requested = round2(Number(line.qty))

    if (!Number.isFinite(available) || !Number.isFinite(requested)) continue
    if (available >= requested) continue

    refusals.push({
      name: line.name,
      itemCode: line.itemCode ?? null,
      requested,
      available: Math.max(0, available),
    })
  }

  return refusals
}

/** Whether every line on this bill may be sold. */
export function canIssueForStock(lines: StockGuardLine[]): boolean {
  return checkFiscalStock(lines).length === 0
}

/**
 * One line a waiter can act on, naming what is short and by how much.
 *
 * Short because it is read mid-service with a guest waiting, and specific
 * because "out of stock" without a name means walking to the store to find out.
 */
export function describeStockRefusal(refusals: StockRefusal[]): string | null {
  if (refusals.length === 0) return null

  const [first] = refusals
  const shortfall = round2(first.requested - first.available)

  if (refusals.length === 1) {
    return `${first.name} is short by ${shortfall} — only ${first.available} left`
  }

  return `${first.name} and ${refusals.length - 1} more are out of stock`
}
