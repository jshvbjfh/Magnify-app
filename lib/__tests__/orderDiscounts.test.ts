// Per-line discounts, at the one place that turns a line into money.
//
// Three separate paths bill a guest: the order totals, the journal entry raised
// at payment, and DishSale.totalSaleAmount. They all call calculateLineNetAmount
// now, so what these tests pin down is the arithmetic every one of them
// inherits. A discount honoured in one path and ignored in another means the
// till collects one figure while the books record another, and nothing surfaces
// it until a reconciliation fails.

import { describe, expect, it } from 'vitest'

import { calculateLineNetAmount, calculateRestaurantOrderTotals } from '@/lib/restaurantOrders'

describe('calculateLineNetAmount', () => {
  it('leaves an undiscounted line at full price', () => {
    expect(calculateLineNetAmount({ dishPrice: 10000, qty: 2 })).toBe(20000)
    expect(calculateLineNetAmount({ dishPrice: 10000, qty: 2, discountPercent: null })).toBe(20000)
  })

  it('takes the percentage off the whole line, not one unit', () => {
    // 3 × 10,000 less 10% is 27,000 — not 30,000 − 1,000.
    expect(calculateLineNetAmount({ dishPrice: 10000, qty: 3, discountPercent: 10 })).toBe(27000)
  })

  it('supports a full 100% discount', () => {
    expect(calculateLineNetAmount({ dishPrice: 8000, qty: 1, discountPercent: 100 })).toBe(0)
  })

  // Everything below is a line a device could push. None may move money the
  // wrong way: a bill must never grow because of a discount, nor go negative.
  it('ignores a discount above 100 rather than paying the guest', () => {
    expect(calculateLineNetAmount({ dishPrice: 5000, qty: 1, discountPercent: 150 })).toBe(5000)
  })

  it('ignores a negative discount rather than inflating the bill', () => {
    expect(calculateLineNetAmount({ dishPrice: 5000, qty: 1, discountPercent: -20 })).toBe(5000)
  })

  it('ignores a discount that is not a number', () => {
    expect(calculateLineNetAmount({ dishPrice: 5000, qty: 1, discountPercent: Number.NaN })).toBe(5000)
    expect(calculateLineNetAmount({ dishPrice: 5000, qty: 1, discountPercent: Infinity })).toBe(5000)
  })

  it('returns zero for a line whose price or qty is not a number', () => {
    expect(calculateLineNetAmount({ dishPrice: Number.NaN, qty: 2, discountPercent: 10 })).toBe(0)
  })
})

describe('calculateRestaurantOrderTotals with discounts', () => {
  it('discounts only the line it was applied to', () => {
    const totals = calculateRestaurantOrderTotals([
      { dishPrice: 10000, qty: 1, discountPercent: 50 },  // 5,000
      { dishPrice: 10000, qty: 1 },                       // 10,000
    ])
    expect(totals.subtotalAmount).toBe(15000)
  })

  it('matches the undiscounted total when no line carries one', () => {
    const items = [{ dishPrice: 4000, qty: 2 }, { dishPrice: 1500, qty: 3 }]
    const plain = calculateRestaurantOrderTotals(items)
    const withNulls = calculateRestaurantOrderTotals(
      items.map((i) => ({ ...i, discountPercent: null })),
    )
    // Every historical line is null, so this equality is what guarantees the
    // migration changed no past total, journal entry or dish sale.
    expect(withNulls).toEqual(plain)
  })

  it('carries the discount through VAT and the gross total', () => {
    const full = calculateRestaurantOrderTotals([{ dishPrice: 10000, qty: 1 }])
    const half = calculateRestaurantOrderTotals([{ dishPrice: 10000, qty: 1, discountPercent: 50 }])
    expect(half.subtotalAmount).toBe(full.subtotalAmount / 2)
    // VAT and the gross are both derived from the net, so a discounted line must
    // reduce the tax too — charging full VAT on a discounted sale would overstate
    // what the venue owes.
    expect(half.vatAmount).toBeCloseTo(full.vatAmount / 2, 6)
    expect(half.totalAmount).toBeCloseTo(full.totalAmount / 2, 6)
  })
})
