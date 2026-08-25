/**
 * syncRestaurantOrderTotals must not lose a per-line discount.
 *
 * A regression test for a live bug, not a hypothetical one.
 *
 * The commit that introduced per-line discounts routed three money paths
 * through calculateLineNetAmount precisely so a discount could not reach some
 * of them and not others. syncRestaurantOrderTotals is a FOURTH path, and it
 * selected only dishPrice and qty from the database. calculateLineNetAmount
 * then saw no discountPercent, read it as undiscounted, and rewrote the order
 * at full menu price.
 *
 * It runs at the top of every settlement, so the effect was: the guest is
 * handed a bill showing "less 10%", pays the discounted amount, and the order,
 * the revenue and the books all record the full one.
 *
 * The fake db below honours `select` the way Prisma does — returning ONLY the
 * projected columns. That is the whole point of the test: a mock that ignores
 * `select` and hands back every field passes against the broken code.
 */

import { describe, expect, it, vi } from 'vitest'

import { syncRestaurantOrderTotals } from '@/lib/restaurantOrders'

const STORED_ITEMS = [
  { dishPrice: 10000, qty: 1, discountPercent: 10, status: 'ACTIVE' },
  { dishPrice: 5000, qty: 2, discountPercent: null, status: 'ACTIVE' },
]

/** A db whose findMany projects exactly the columns asked for, as Prisma does. */
function makeDb() {
  const update = vi.fn().mockResolvedValue({})

  return {
    update,
    db: {
      orderItem: {
        findMany: vi.fn(async ({ select }: { select?: Record<string, boolean> }) => {
          if (!select) return STORED_ITEMS
          return STORED_ITEMS.map((item) =>
            Object.fromEntries(
              Object.keys(select)
                .filter((key) => select[key])
                .map((key) => [key, item[key as keyof typeof item]]),
            ),
          )
        }),
      },
      restaurantOrder: { update },
    },
  }
}

describe('syncRestaurantOrderTotals', () => {
  it('keeps the discount when it recomputes an order', async () => {
    const { db, update } = makeDb()

    await syncRestaurantOrderTotals(db as never, 'ord-1')

    // 10,000 less 10% = 9,000, plus 2 × 5,000 = 10,000. Total 19,000.
    // Before the fix this wrote 20,000 — the guest's discount, silently undone.
    expect(update).toHaveBeenCalledTimes(1)
    expect(update.mock.calls[0][0].data.totalAmount).toBe(19000)
    expect(update.mock.calls[0][0].data.subtotalAmount).toBe(19000)
  })

  it('asks the database for the discount column', async () => {
    const { db } = makeDb()

    await syncRestaurantOrderTotals(db as never, 'ord-1')

    // Asserted directly as well as through the arithmetic above: the projection
    // IS the bug, and stating it here says so to whoever edits this next.
    expect(db.orderItem.findMany.mock.calls[0][0].select).toMatchObject({
      discountPercent: true,
    })
  })

  it('leaves an undiscounted order exactly where it was', async () => {
    const update = vi.fn().mockResolvedValue({})
    const db = {
      orderItem: { findMany: vi.fn().mockResolvedValue([{ dishPrice: 4000, qty: 3, discountPercent: null }]) },
      restaurantOrder: { update },
    }

    await syncRestaurantOrderTotals(db as never, 'ord-2')

    expect(update.mock.calls[0][0].data.totalAmount).toBe(12000)
  })
})
