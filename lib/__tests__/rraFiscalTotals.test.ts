// VAT under RRA fiscal mode.
//
// Two properties matter more than any individual figure here, and both are
// things that would be discovered late and expensively:
//
//   1. Switching fiscal mode ON must not change what the guest pays. Tax is
//      carved out of the menu price, not added to it. Get this backwards and
//      every price in the restaurant rises 18% on the day it ships.
//
//   2. Switching fiscal mode OFF must reproduce today's figures exactly — not
//      to the franc, bit-for-bit — because reports compare against totals
//      already stored for orders taken before any of this existed.

import { describe, expect, it } from 'vitest'

import { calculateRestaurantOrderTotals, summarizeTaxByCategory } from '@/lib/restaurantOrders'
import { normalizeTaxCategory, splitTaxInclusive } from '@/lib/restaurantVat'

const fiscal = { fiscalMode: true }

describe('fiscal mode off', () => {
  it('produces figures identical to before RRA work existed', () => {
    const items = [
      { dishPrice: 5000, qty: 2 },
      { dishPrice: 3300, qty: 1, discountPercent: 10 },
    ]

    const totals = calculateRestaurantOrderTotals(items)

    // The old contract: subtotal is the raw sum, VAT is nothing, total is the
    // subtotal. Written as literals rather than derived, so a change to the
    // calculation cannot quietly change what this asserts.
    expect(totals.subtotalAmount).toBe(12970)
    expect(totals.vatAmount).toBe(0)
    expect(totals.totalAmount).toBe(12970)
    expect(totals.taxLines).toEqual([])
  })

  it('ignores a tax category when the venue is not fiscal', () => {
    const withCategory = calculateRestaurantOrderTotals([{ dishPrice: 5000, qty: 1, taxCategory: 'B' }])
    const without = calculateRestaurantOrderTotals([{ dishPrice: 5000, qty: 1 }])

    expect(withCategory).toEqual(without)
  })

  it('is the default — a caller that passes no options gets the old behaviour', () => {
    expect(calculateRestaurantOrderTotals([{ dishPrice: 5000, qty: 1 }]).vatAmount).toBe(0)
  })
})

describe('fiscal mode on', () => {
  it('does not change what the guest pays', () => {
    const items = [{ dishPrice: 5000, qty: 1, taxCategory: 'B' }]

    const off = calculateRestaurantOrderTotals(items)
    const on = calculateRestaurantOrderTotals(items, fiscal)

    expect(on.totalAmount).toBe(off.totalAmount)
    expect(on.totalAmount).toBe(5000)
  })

  it('carves 18% out of the menu price rather than adding it on top', () => {
    const totals = calculateRestaurantOrderTotals([{ dishPrice: 5000, qty: 1, taxCategory: 'B' }], fiscal)

    expect(totals.totalAmount).toBe(5000)
    expect(totals.subtotalAmount).toBe(4237.29)
    expect(totals.vatAmount).toBe(762.71)
    // The whole point: 5,000 in, 5,000 out. Never 5,900.
    expect(totals.subtotalAmount + totals.vatAmount).toBe(5000)
  })

  it('treats a missing tax category as standard-rated, not exempt', () => {
    const untagged = calculateRestaurantOrderTotals([{ dishPrice: 5000, qty: 1 }], fiscal)
    const standard = calculateRestaurantOrderTotals([{ dishPrice: 5000, qty: 1, taxCategory: 'B' }], fiscal)

    expect(untagged.vatAmount).toBe(standard.vatAmount)
    expect(untagged.vatAmount).toBeGreaterThan(0)
  })

  it('charges no tax on an exempt or zero-rated line', () => {
    for (const category of ['A', 'C']) {
      const totals = calculateRestaurantOrderTotals([{ dishPrice: 5000, qty: 1, taxCategory: category }], fiscal)

      expect(totals.vatAmount).toBe(0)
      expect(totals.subtotalAmount).toBe(5000)
      expect(totals.totalAmount).toBe(5000)
    }
  })
})

describe('discounts under fiscal mode', () => {
  it('reduces the tax in proportion to the discount', () => {
    const full = calculateRestaurantOrderTotals([{ dishPrice: 5000, qty: 1, taxCategory: 'B' }], fiscal)
    const half = calculateRestaurantOrderTotals([{ dishPrice: 5000, qty: 1, taxCategory: 'B', discountPercent: 50 }], fiscal)

    expect(half.totalAmount).toBe(2500)
    expect(half.vatAmount).toBeCloseTo(full.vatAmount / 2, 2)
  })

  it('taxes the discounted price, not the menu price', () => {
    // 5,000 less 10% is 4,500 to the guest; the tax is 18% carved out of 4,500.
    const totals = calculateRestaurantOrderTotals(
      [{ dishPrice: 5000, qty: 1, taxCategory: 'B', discountPercent: 10 }],
      fiscal,
    )

    expect(totals.totalAmount).toBe(4500)
    expect(totals.subtotalAmount).toBe(3813.56)
    expect(totals.vatAmount).toBe(686.44)
  })

  it('charges nothing on a fully discounted line', () => {
    const totals = calculateRestaurantOrderTotals(
      [{ dishPrice: 8000, qty: 1, taxCategory: 'B', discountPercent: 100 }],
      fiscal,
    )

    expect(totals.totalAmount).toBe(0)
    expect(totals.vatAmount).toBe(0)
  })
})

describe('rounding', () => {
  // The reconciliation RRA's signature depends on: the lines and the totals
  // have to agree exactly, not approximately.
  it('keeps taxable + tax equal to the price charged, on every line', () => {
    const awkward = [7, 33, 99, 101, 333, 1234, 4999, 12345, 99999]

    for (const price of awkward) {
      const { taxableAmount, taxAmount } = splitTaxInclusive(price, 'B')
      expect(taxableAmount + taxAmount).toBe(price)
    }
  })

  it('keeps the order total equal to the sum of its lines', () => {
    const items = Array.from({ length: 17 }, (_, i) => ({
      dishPrice: 333 + i * 97,
      qty: (i % 3) + 1,
      taxCategory: 'B',
      discountPercent: i % 4 === 0 ? 15 : null,
    }))

    const totals = calculateRestaurantOrderTotals(items, fiscal)
    const summedLines = totals.taxLines.reduce((sum, line) => sum + line.grossAmount, 0)

    expect(totals.totalAmount).toBeCloseTo(summedLines, 2)
    expect(totals.subtotalAmount + totals.vatAmount).toBe(totals.totalAmount)
  })

  it('reconciles a bill mixing every tax bracket', () => {
    const totals = calculateRestaurantOrderTotals(
      [
        { dishPrice: 5000, qty: 1, taxCategory: 'B' },
        { dishPrice: 1200, qty: 3, taxCategory: 'A' },
        { dishPrice: 777, qty: 2, taxCategory: 'C' },
        { dishPrice: 4321, qty: 1, taxCategory: 'B', discountPercent: 25 },
      ],
      fiscal,
    )

    expect(totals.subtotalAmount + totals.vatAmount).toBe(totals.totalAmount)

    const byCategory = summarizeTaxByCategory(totals.taxLines)
    const categories = byCategory.map((row) => row.category)

    expect(categories).toEqual(['A', 'B', 'C'])
    // Only the standard-rated bracket carries tax.
    expect(byCategory.find((row) => row.category === 'A')?.taxAmount).toBe(0)
    expect(byCategory.find((row) => row.category === 'C')?.taxAmount).toBe(0)
    expect(byCategory.find((row) => row.category === 'B')?.taxAmount).toBeGreaterThan(0)
  })
})

describe('normalizeTaxCategory', () => {
  it('accepts the four brackets in any casing', () => {
    expect(normalizeTaxCategory('a')).toBe('A')
    expect(normalizeTaxCategory(' b ')).toBe('B')
    expect(normalizeTaxCategory('C')).toBe('C')
    expect(normalizeTaxCategory('d')).toBe('D')
  })

  it('falls back to standard-rated for anything it does not recognise', () => {
    // Under-declaring is the expensive direction to be wrong in, so an unknown
    // value must never resolve to exempt.
    for (const value of [null, undefined, '', 'X', 'exempt', 42, {}]) {
      expect(normalizeTaxCategory(value)).toBe('B')
    }
  })
})
