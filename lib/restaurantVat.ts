// ─── VAT ────────────────────────────────────────────────────────────────────
//
// Two modes live here, and which one runs is decided per restaurant by
// Restaurant.rraFiscalMode.
//
// OFF (every venue today): no VAT is counted anywhere. Total = sum of net
// prices. The three legacy helpers below are unchanged and un-rounded on
// purpose — a venue that has not been switched over must produce figures
// identical to the ones it produced before any of this existed.
//
// ON (Rwanda, RRA/EBM): menu prices INCLUDE VAT, so tax is split out of the
// price rather than added on top. A 5,000 Rwf plate stays 5,000 Rwf to the
// guest; 4,237.29 is the taxable amount and 762.71 is the tax. Adding 18% on
// top instead would silently reprice the entire menu.

/** Legacy rate. Deliberately 0 — see the note above. */
export const RESTAURANT_VAT_RATE = 0

export function calculateVatFromNet(netAmount: number) {
  return Number(netAmount) * RESTAURANT_VAT_RATE
}

export function calculateGrossFromNet(netAmount: number) {
  return Number(netAmount) + calculateVatFromNet(netAmount)
}

// ─── RRA tax categories ─────────────────────────────────────────────────────
//
// Rwanda's EBM tax brackets. B (standard rate) covers almost everything a
// restaurant sells.
//
// !! These rates are NOT read from the RRA specification. They are the commonly
// documented values and MUST be confirmed against the VSDC spec before anything
// is submitted for certification — D in particular, which covers special
// regimes this app has no example of. Confirming them is a spec-reading task,
// not a code change: only the numbers below move.
export const RRA_TAX_CATEGORIES = {
  A: { label: 'Exempt', rate: 0 },
  B: { label: 'Standard 18%', rate: 0.18 },
  C: { label: 'Zero-rated', rate: 0 },
  D: { label: 'Special', rate: 0 },
} as const

export type RraTaxCategory = keyof typeof RRA_TAX_CATEGORIES

/**
 * What an item is taxed at when nobody has said otherwise.
 *
 * Standard-rated, not exempt. A dish that has not been classified yet is far
 * more likely to be ordinary restaurant food than an exempt supply, and
 * under-declaring tax is the expensive direction to be wrong in.
 */
export const DEFAULT_TAX_CATEGORY: RraTaxCategory = 'B'

export function isRraTaxCategory(value: unknown): value is RraTaxCategory {
  return typeof value === 'string' && Object.hasOwn(RRA_TAX_CATEGORIES, value)
}

/** Coerces whatever is stored on the dish into a category we can tax. */
export function normalizeTaxCategory(value: unknown): RraTaxCategory {
  if (typeof value !== 'string') return DEFAULT_TAX_CATEGORY
  const upper = value.trim().toUpperCase()
  return isRraTaxCategory(upper) ? upper : DEFAULT_TAX_CATEGORY
}

export function rateForTaxCategory(category: RraTaxCategory): number {
  return RRA_TAX_CATEGORIES[category].rate
}

/**
 * Two decimal places.
 *
 * Every money figure that leaves this module goes through here. RRA wants two
 * decimals, and — more importantly — the receipt signature covers both the line
 * amounts and the totals, so the two have to reconcile exactly rather than
 * approximately. Float sums do not, left to themselves.
 */
export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 100) / 100
}

/**
 * Splits a VAT-inclusive amount into what is taxable and what is tax.
 *
 * The tax is taken as the REMAINDER after rounding the taxable amount, never
 * rounded independently. That is what guarantees `taxableAmount + taxAmount`
 * equals the price the guest was charged, to the franc, every time — round both
 * halves separately and they disagree on roughly one line in fifty.
 */
export function splitTaxInclusive(grossAmount: number, category: RraTaxCategory) {
  const gross = round2(Number(grossAmount))
  const rate = rateForTaxCategory(category)

  if (!(rate > 0)) {
    return { taxableAmount: gross, taxAmount: 0 }
  }

  const taxableAmount = round2(gross / (1 + rate))
  return { taxableAmount, taxAmount: round2(gross - taxableAmount) }
}
