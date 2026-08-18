// The till shows a guest one figure and the server books another to the
// accounts. These are two separate implementations of the same rule —
// lineNetAmount here, calculateLineNetAmount in lib/restaurantOrders.ts — and
// they must agree to the franc. This suite is the copy that keeps them honest;
// lib/__tests__/orderDiscounts.test.ts asserts the same cases on the server.

import { describe, expect, it, vi } from 'vitest'

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {},
  SQLiteDBConnection: class {},
  SQLiteConnection: class {},
}))

const { lineNetAmount } = await import('../db')

const line = (dish_price: number, qty: number, discount_percent?: number | null) =>
  ({ dish_price, qty, discount_percent })

describe('lineNetAmount (client) matches the server rule', () => {
  it('leaves an undiscounted line at full price', () => {
    expect(lineNetAmount(line(10000, 2))).toBe(20000)
    expect(lineNetAmount(line(10000, 2, null))).toBe(20000)
  })

  it('takes the percentage off the whole line, not one unit', () => {
    expect(lineNetAmount(line(10000, 3, 10))).toBe(27000)
  })

  it('supports a full 100% discount', () => {
    expect(lineNetAmount(line(8000, 1, 100))).toBe(0)
  })

  // A bill must never grow because of a discount, nor go below zero. These are
  // the values a mistyped field or a stale sync could realistically produce.
  it('ignores a discount above 100', () => {
    expect(lineNetAmount(line(5000, 1, 150))).toBe(5000)
  })

  it('ignores a negative discount', () => {
    expect(lineNetAmount(line(5000, 1, -20))).toBe(5000)
  })

  it('ignores a discount that is not a number', () => {
    expect(lineNetAmount(line(5000, 1, Number.NaN))).toBe(5000)
    expect(lineNetAmount(line(5000, 1, Infinity))).toBe(5000)
  })

  it('returns zero when the price is not a number', () => {
    expect(lineNetAmount(line(Number.NaN, 2, 10))).toBe(0)
  })

  // Every line taken before discounts existed carries null. If this ever
  // stopped equalling the plain calculation, the feature would have silently
  // repriced history.
  it('prices a null discount exactly as no discount at all', () => {
    for (const [price, qty] of [[4000, 2], [1500, 3], [12345, 1]] as const) {
      expect(lineNetAmount(line(price, qty, null))).toBe(price * qty)
    }
  })
})
