/**
 * Unit tests for a "No Charge" (comped) settlement.
 *
 * A comp is the one settlement where the food is real and the money is not, so
 * the two halves have to come apart cleanly:
 *  - the order closes at zero and the written-off value is kept on compedAmount,
 *    which is what keeps revenue, APC and every sales report honest without any
 *    of them having to learn that comps exist;
 *  - no revenue journal entry is raised, so the Transactions page never shows
 *    income that never arrived;
 *  - the dish sales are still recorded, because the stock really did leave the
 *    store — they are just booked at zero;
 *  - SIROCCO Y SOL's hotel buffet is held OUT of the comp entirely: the hotel
 *    settles it, not the guest, so comping the guest's bill cannot cancel it.
 *
 * All Prisma DB calls are mocked. calculateRestaurantOrderTotals is kept REAL so
 * the asserted amounts reflect the same (VAT-aware) math production uses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../dishSaleRecording', () => ({
  recordDishSalesForPaidOrder: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../accounting', () => ({
  recordJournalEntry: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../restaurantOrders', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>()
  return {
    ...actual,
    syncRestaurantOrderTotals: vi.fn().mockResolvedValue(undefined),
    enqueueOrderSync: vi.fn().mockResolvedValue(undefined),
  }
})

vi.mock('../restaurantTableSync', () => ({
  enqueueRestaurantTableSync: vi.fn().mockResolvedValue(undefined),
}))

import { finalizeRestaurantOrderPayment } from '../restaurantOrderPayment'
import { recordJournalEntry } from '../accounting'
import { recordDishSalesForPaidOrder } from '../dishSaleRecording'
import { calculateRestaurantOrderTotals, isNoChargeMethod, NO_CHARGE_METHOD, NO_CHARGE_METHOD_VALUES } from '../restaurantOrders'

const recordJournalEntryMock = vi.mocked(recordJournalEntry)
const recordDishSalesMock = vi.mocked(recordDishSalesForPaidOrder)

// The real SIROCCO Y SOL id — the buffet rule is scoped to this one account on
// purpose (see lib/hotelBuffet.ts), so the test has to use it to exercise it.
const SIROCCO = 'cmssn2wif000210rcxlzs1jny'
const OTHER_RESTAURANT = 'rest-1'
const ORDER = 'ord-1'
const TILL = 'main'

function grossOf(items: Array<{ dishPrice: number; qty: number }>) {
  return calculateRestaurantOrderTotals(items.map((i) => ({ dishPrice: i.dishPrice, qty: i.qty }))).totalAmount
}

function makeDb(opts: {
  restaurantId: string
  items: Array<{ id: string; dishId: string; dishName: string; dishPrice: number; qty: number }>
}) {
  const items = opts.items.map((i) => ({
    ...i, dishVariantId: null, dishVariantName: null, status: 'ACTIVE', discountPercent: null,
  }))
  const current = {
    id: ORDER, restaurantId: opts.restaurantId, branchId: TILL, status: 'OPEN',
    tableId: null, tableName: 'Takeaway', paidAt: null, paymentMethod: null,
    businessDate: null, items,
  }
  const paid = { ...current, status: 'PAID', paidAt: new Date('2026-08-21T18:00:00Z') }
  const updateMany = vi.fn().mockResolvedValue({ count: 1 })
  const db = {
    restaurantOrder: {
      findFirst: vi.fn().mockResolvedValueOnce(current).mockResolvedValueOnce(paid),
      updateMany,
    },
    journalEntry: { count: vi.fn().mockResolvedValue(0) },
    dishSale: {
      findMany: vi.fn().mockResolvedValue(
        opts.items.map((i) => ({ dishId: i.dishId, orderItemId: i.id, branchId: TILL })),
      ),
    },
    restaurantTable: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    // The buffet path double-checks the dish category before trusting a name
    // match, so the buffet tests only reach their assertions with this present.
    dish: {
      findMany: vi.fn().mockResolvedValue(
        opts.items.map((i) => ({ id: i.dishId, category: 'breakfast buffet table' })),
      ),
    },
  } as any
  return { db, updateMany }
}

/** The data payload the order was written down with. */
function settlementWrite(updateMany: ReturnType<typeof vi.fn>) {
  return updateMany.mock.calls[0][0].data as Record<string, unknown>
}

beforeEach(() => {
  recordJournalEntryMock.mockClear()
  recordDishSalesMock.mockClear()
})

describe('isNoChargeMethod', () => {
  it('recognises the tender however the device cased or padded it', () => {
    expect(isNoChargeMethod(NO_CHARGE_METHOD)).toBe(true)
    expect(isNoChargeMethod('  complementary ')).toBe(true)
    expect(isNoChargeMethod('COMPLEMENTARY')).toBe(true)
  })

  it('still recognises the older "No Charge" spelling from tills in the field', () => {
    // The tender was renamed to 'compl.' AFTER 'No Charge' had already shipped
    // to tills. Those tills keep sending the old string until each one updates,
    // and a comp that stops being recognised is booked as revenue nobody
    // collected. This test is the guard on that — do not relax it.
    expect(isNoChargeMethod('No Charge')).toBe(true)
    expect(isNoChargeMethod('no charge')).toBe(true)
    // 'compl.' was the name for part of one afternoon; a till that settled a
    // bill in that window must still have it counted as a comp.
    expect(isNoChargeMethod('compl.')).toBe(true)
    // Both spellings of the word mean the same free meal.
    expect(isNoChargeMethod('complimentary')).toBe(true)
    expect(isNoChargeMethod('complementary')).toBe(true)
  })

  it('lists every stored spelling for SQL filters', () => {
    // The reports match in SQL and cannot call isNoChargeMethod, so the two
    // must not drift apart — a spelling missing here is a comp missing from
    // the report.
    for (const value of NO_CHARGE_METHOD_VALUES) {
      expect(isNoChargeMethod(value)).toBe(true)
    }
    expect(NO_CHARGE_METHOD_VALUES).toContain('No Charge')
    expect(NO_CHARGE_METHOD_VALUES).toContain('compl.')
    // The value the till actually writes today has to be in the SQL list, or
    // every comp settled from now on is missing from the report.
    expect(NO_CHARGE_METHOD_VALUES).toContain(NO_CHARGE_METHOD)
  })

  it('does not mistake any real tender for a comp', () => {
    for (const tender of ['Cash', 'MoMo', 'Card', 'Bank Transfer', 'Credit', '', null, undefined]) {
      expect(isNoChargeMethod(tender)).toBe(false)
    }
  })
})

describe('finalizeRestaurantOrderPayment — No Charge', () => {
  it('closes the bill at zero and keeps the menu value as the comped amount', async () => {
    const { db, updateMany } = makeDb({
      restaurantId: OTHER_RESTAURANT,
      items: [
        { id: 'it-A', dishId: 'dish-A', dishName: 'Teriyaki Chicken Bowl', dishPrice: 10000, qty: 1 },
        { id: 'it-B', dishId: 'dish-B', dishName: 'Fries', dishPrice: 2000, qty: 2 },
      ],
    })

    await finalizeRestaurantOrderPayment(db, {
      restaurantId: OTHER_RESTAURANT, branchId: TILL, orderId: ORDER, paymentMethod: NO_CHARGE_METHOD,
    })

    const written = settlementWrite(updateMany)
    // Zero everywhere the reports read. This is the whole mechanism: a comp
    // contributes nothing to revenue because it literally stores nothing.
    expect(written.totalAmount).toBe(0)
    expect(written.subtotalAmount).toBe(0)
    expect(written.vatAmount).toBe(0)
    // ...and the value that was given away survives in the one place built for it.
    expect(written.compedAmount).toBe(grossOf([
      { dishPrice: 10000, qty: 1 },
      { dishPrice: 2000, qty: 2 },
    ]))
  })

  it('books no revenue at all — nothing was collected', async () => {
    const { db } = makeDb({
      restaurantId: OTHER_RESTAURANT,
      items: [{ id: 'it-A', dishId: 'dish-A', dishName: 'Teriyaki Chicken Bowl', dishPrice: 10000, qty: 1 }],
    })

    await finalizeRestaurantOrderPayment(db, {
      restaurantId: OTHER_RESTAURANT, branchId: TILL, orderId: ORDER, paymentMethod: NO_CHARGE_METHOD,
    })

    expect(recordJournalEntryMock).not.toHaveBeenCalled()
  })

  it('still records the dish sales, at zero — the stock really did leave the store', async () => {
    const { db } = makeDb({
      restaurantId: OTHER_RESTAURANT,
      items: [{ id: 'it-A', dishId: 'dish-A', dishName: 'Teriyaki Chicken Bowl', dishPrice: 10000, qty: 1 }],
    })

    await finalizeRestaurantOrderPayment(db, {
      restaurantId: OTHER_RESTAURANT, branchId: TILL, orderId: ORDER, paymentMethod: NO_CHARGE_METHOD,
    })

    expect(recordDishSalesMock).toHaveBeenCalledTimes(1)
    const args = recordDishSalesMock.mock.calls[0][1] as Record<string, unknown>
    // Sales are recorded (so COGS and inventory move) but flagged to book no money.
    expect(args.zeroRevenue).toBe(true)
    expect((args.items as unknown[]).length).toBe(1)
  })

  it('leaves an ordinary paid bill completely untouched', async () => {
    const { db, updateMany } = makeDb({
      restaurantId: OTHER_RESTAURANT,
      items: [{ id: 'it-A', dishId: 'dish-A', dishName: 'Teriyaki Chicken Bowl', dishPrice: 10000, qty: 1 }],
    })

    await finalizeRestaurantOrderPayment(db, {
      restaurantId: OTHER_RESTAURANT, branchId: TILL, orderId: ORDER, paymentMethod: 'Cash',
    })

    const written = settlementWrite(updateMany)
    // No comp fields written at all, and the revenue booking happens as before.
    expect(written.compedAmount).toBeUndefined()
    expect(written.totalAmount).toBeUndefined()
    expect(recordJournalEntryMock).toHaveBeenCalledTimes(1)
    expect(recordDishSalesMock.mock.calls[0][1]).toMatchObject({ zeroRevenue: false })
  })
})

describe('finalizeRestaurantOrderPayment — No Charge vs the SIROCCO hotel buffet', () => {
  it('holds the buffet out of the comp: the hotel still owes for it', async () => {
    const { db, updateMany } = makeDb({
      restaurantId: SIROCCO,
      items: [
        { id: 'it-A', dishId: 'dish-A', dishName: 'HOTEL BUFFET', dishPrice: 8000, qty: 2 },
        { id: 'it-B', dishId: 'dish-B', dishName: 'Mutzig', dishPrice: 3000, qty: 1 },
      ],
    })

    await finalizeRestaurantOrderPayment(db, {
      restaurantId: SIROCCO, branchId: TILL, orderId: ORDER, paymentMethod: NO_CHARGE_METHOD,
    })

    const written = settlementWrite(updateMany)
    // Only the beer was given away.
    expect(written.compedAmount).toBe(grossOf([{ dishPrice: 3000, qty: 1 }]))
    // The buffet is still owed, so the order does NOT fall to zero.
    expect(written.totalAmount).toBe(grossOf([{ dishPrice: 8000, qty: 2 }]))

    // And the hotel's receivable is still booked — exactly one entry, on Credit,
    // for the buffet alone. Comping the guest's drink must not wipe it.
    expect(recordJournalEntryMock).toHaveBeenCalledTimes(1)
    const entry = recordJournalEntryMock.mock.calls[0][1] as Record<string, unknown>
    expect(entry.paymentMethod).toBe('Credit')
    expect(entry.amount).toBe(grossOf([{ dishPrice: 8000, qty: 2 }]))
  })

  it('comps the whole bill for any other restaurant, buffet-named dish or not', async () => {
    // Same dish name, different account. The buffet rule is scoped to SIROCCO on
    // purpose, so here it must behave like any ordinary line and be comped.
    const { db, updateMany } = makeDb({
      restaurantId: OTHER_RESTAURANT,
      items: [{ id: 'it-A', dishId: 'dish-A', dishName: 'HOTEL BUFFET', dishPrice: 8000, qty: 2 }],
    })

    await finalizeRestaurantOrderPayment(db, {
      restaurantId: OTHER_RESTAURANT, branchId: TILL, orderId: ORDER, paymentMethod: NO_CHARGE_METHOD,
    })

    const written = settlementWrite(updateMany)
    expect(written.totalAmount).toBe(0)
    expect(written.compedAmount).toBe(grossOf([{ dishPrice: 8000, qty: 2 }]))
    expect(recordJournalEntryMock).not.toHaveBeenCalled()
  })
})
