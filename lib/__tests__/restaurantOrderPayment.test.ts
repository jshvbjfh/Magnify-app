/**
 * Unit tests for finalizeRestaurantOrderPayment — specifically the per-station
 * journal-entry booking. Proves the Transaction-page fix:
 *  - revenue is split per station using the DishSale rows (source of truth),
 *    never lumped under the paying till's station;
 *  - booking is idempotent (a re-run can't double-book);
 *  - an item with no DishSale (unresolved dish) is skipped, not mis-booked.
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
import { calculateRestaurantOrderTotals } from '../restaurantOrders'

const recordJournalEntryMock = vi.mocked(recordJournalEntry)

const REST = 'rest-1'
const ORDER = 'ord-1'
const TILL = 'little-taipei' // the terminal that rang the order up

const ITEMS = [
  { id: 'it-A', dishId: 'dish-A', dishName: 'Mutzig', dishPrice: 3000, qty: 1, dishVariantId: null, dishVariantName: null, status: 'ACTIVE' },
  { id: 'it-B', dishId: 'dish-B', dishName: 'Teriyaki Chicken Bowl', dishPrice: 10000, qty: 1, dishVariantId: null, dishVariantName: null, status: 'ACTIVE' },
  { id: 'it-C', dishId: 'dish-C', dishName: 'Fries', dishPrice: 2000, qty: 1, dishVariantId: null, dishVariantName: null, status: 'ACTIVE' },
]

function grossOf(items: Array<{ dishPrice: number; qty: number }>) {
  return calculateRestaurantOrderTotals(items.map((i) => ({ dishPrice: i.dishPrice, qty: i.qty }))).totalAmount
}

/** Build a mock db. `dishSales` drives the per-station grouping; `journalCount` drives idempotency. */
function makeDb(opts: { dishSales: Array<{ dishId: string; orderItemId: string; branchId: string }>; journalCount?: number }) {
  const current = { id: ORDER, restaurantId: REST, branchId: TILL, status: 'OPEN', tableId: null, tableName: 'Takeaway', paidAt: null, paymentMethod: null, items: ITEMS }
  const paid = { ...current, status: 'PAID', paidAt: new Date('2026-07-16T16:44:00Z') }
  const findFirst = vi.fn()
    .mockResolvedValueOnce(current) // currentOrder lookup
    .mockResolvedValueOnce(paid)    // paidOrder lookup after updateMany
  return {
    restaurantOrder: {
      findFirst,
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    journalEntry: {
      count: vi.fn().mockResolvedValue(opts.journalCount ?? 0),
    },
    dishSale: {
      findMany: vi.fn().mockResolvedValue(opts.dishSales),
    },
    restaurantTable: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  } as any
}

function callsByBranch() {
  const map = new Map<string, { amount: number; reference: string }>()
  for (const call of recordJournalEntryMock.mock.calls) {
    const arg = call[1] as any
    map.set(arg.branchId, { amount: arg.amount, reference: arg.reference })
  }
  return map
}

beforeEach(() => {
  recordJournalEntryMock.mockClear()
})

describe('finalizeRestaurantOrderPayment — per-station journal booking', () => {
  it('splits revenue per dish station from DishSale rows, never lumping under the till', async () => {
    const db = makeDb({
      dishSales: [
        { dishId: 'dish-A', orderItemId: 'it-A', branchId: 'parking-bar' },
        { dishId: 'dish-B', orderItemId: 'it-B', branchId: 'little-taipei' },
        { dishId: 'dish-C', orderItemId: 'it-C', branchId: 'whataburger' },
      ],
    })

    await finalizeRestaurantOrderPayment(db, { restaurantId: REST, branchId: TILL, orderId: ORDER, paymentMethod: 'Mobile Money' })

    const byBranch = callsByBranch()
    // one entry per station, not one lumped entry
    expect(recordJournalEntryMock).toHaveBeenCalledTimes(3)
    expect([...byBranch.keys()].sort()).toEqual(['little-taipei', 'parking-bar', 'whataburger'])

    // each station gets ONLY its own dish's revenue
    expect(byBranch.get('parking-bar')!.amount).toBe(grossOf([{ dishPrice: 3000, qty: 1 }]))
    expect(byBranch.get('whataburger')!.amount).toBe(grossOf([{ dishPrice: 2000, qty: 1 }]))
    // Little Taipei earns only the 10,000 Teriyaki — NOT the whole 15,000 order
    expect(byBranch.get('little-taipei')!.amount).toBe(grossOf([{ dishPrice: 10000, qty: 1 }]))

    // every entry references its order (idempotency key + traceability)
    for (const v of byBranch.values()) expect(v.reference).toBe(`order:${ORDER}`)
  })

  it('does not book again when the order is already booked (idempotent)', async () => {
    const db = makeDb({
      dishSales: [{ dishId: 'dish-A', orderItemId: 'it-A', branchId: 'parking-bar' }],
      journalCount: 1, // a prior booking exists for this order
    })

    await finalizeRestaurantOrderPayment(db, { restaurantId: REST, branchId: TILL, orderId: ORDER, paymentMethod: 'Cash' })

    expect(recordJournalEntryMock).not.toHaveBeenCalled()
  })

  it('skips an item that has no DishSale instead of crediting the till', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = makeDb({
      // only dish-A resolved to a sale; dish-B and dish-C did not
      dishSales: [{ dishId: 'dish-A', orderItemId: 'it-A', branchId: 'parking-bar' }],
    })

    await finalizeRestaurantOrderPayment(db, { restaurantId: REST, branchId: TILL, orderId: ORDER, paymentMethod: 'Cash' })

    const byBranch = callsByBranch()
    expect(recordJournalEntryMock).toHaveBeenCalledTimes(1)
    expect([...byBranch.keys()]).toEqual(['parking-bar'])
    // crucially, the till (little-taipei) is NOT credited for the unresolved items
    expect(byBranch.has(TILL)).toBe(false)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

// The hotel settles its buffet covers itself, later — so that revenue must book
// to Accounts Receivable ('Credit') and never into the till with the cash the
// guest handed over for their add-ons.
describe('finalizeRestaurantOrderPayment — hotel buffet books to Accounts Receivable', () => {
  const BREAKFAST = 'breakfast-menu'

  /** Order of a hotel buffet plus whatever add-ons are passed. */
  function makeBuffetDb(addOns: Array<{ id: string; dishId: string; dishName: string; dishPrice: number }>) {
    const items = [
      { id: 'it-buffet', dishId: 'dish-buffet', dishName: 'HOTEL BUFFET', dishPrice: 12000, qty: 1, dishVariantId: null, dishVariantName: null, status: 'ACTIVE' },
      ...addOns.map((a) => ({ ...a, qty: 1, dishVariantId: null, dishVariantName: null, status: 'ACTIVE' })),
    ]
    const current = { id: ORDER, restaurantId: REST, branchId: BREAKFAST, status: 'OPEN', tableId: 't-4', tableName: 'T4', paidAt: null, paymentMethod: null, items }
    const paid = { ...current, status: 'PAID', paidAt: new Date('2026-08-14T07:15:00Z') }
    return {
      restaurantOrder: {
        findFirst: vi.fn().mockResolvedValueOnce(current).mockResolvedValueOnce(paid),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      journalEntry: { count: vi.fn().mockResolvedValue(0) },
      dishSale: {
        findMany: vi.fn().mockResolvedValue(
          items.map((i) => ({ dishId: i.dishId, orderItemId: i.id, branchId: BREAKFAST })),
        ),
      },
      dish: {
        findMany: vi.fn().mockResolvedValue([{ id: 'dish-buffet', category: 'Breakfast buffet table' }]),
      },
      restaurantTable: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    } as any
  }

  function callsByTender() {
    const map = new Map<string, number>()
    for (const call of recordJournalEntryMock.mock.calls) {
      const arg = call[1] as any
      map.set(arg.paymentMethod, (map.get(arg.paymentMethod) ?? 0) + arg.amount)
    }
    return map
  }

  it('books the buffet to Credit and the add-ons to the tender the guest paid', async () => {
    const db = makeBuffetDb([{ id: 'it-egg', dishId: 'dish-egg', dishName: 'Poached egg', dishPrice: 5000 }])

    await finalizeRestaurantOrderPayment(db, { restaurantId: REST, branchId: BREAKFAST, orderId: ORDER, paymentMethod: 'Cash' })

    const byTender = callsByTender()
    expect(recordJournalEntryMock).toHaveBeenCalledTimes(2)
    // The hotel owes the buffet; the guest paid only for the egg.
    expect(byTender.get('Credit')).toBe(grossOf([{ dishPrice: 12000, qty: 1 }]))
    expect(byTender.get('Cash')).toBe(grossOf([{ dishPrice: 5000, qty: 1 }]))
  })

  it('books a buffet ordered alone entirely to Credit, never to the till', async () => {
    const db = makeBuffetDb([])

    await finalizeRestaurantOrderPayment(db, { restaurantId: REST, branchId: BREAKFAST, orderId: ORDER, paymentMethod: 'Cash' })

    const byTender = callsByTender()
    expect(recordJournalEntryMock).toHaveBeenCalledTimes(1)
    expect(byTender.get('Credit')).toBe(grossOf([{ dishPrice: 12000, qty: 1 }]))
    expect(byTender.has('Cash')).toBe(false)
  })

  it('leaves an ordinary order on a single tender, with no dish lookup at all', async () => {
    const db = makeDb({
      dishSales: [
        { dishId: 'dish-A', orderItemId: 'it-A', branchId: 'parking-bar' },
        { dishId: 'dish-B', orderItemId: 'it-B', branchId: 'parking-bar' },
        { dishId: 'dish-C', orderItemId: 'it-C', branchId: 'parking-bar' },
      ],
    })

    await finalizeRestaurantOrderPayment(db, { restaurantId: REST, branchId: TILL, orderId: ORDER, paymentMethod: 'Cash' })

    const byTender = callsByTender()
    expect(recordJournalEntryMock).toHaveBeenCalledTimes(1)
    expect(byTender.get('Cash')).toBe(grossOf(ITEMS))
    expect(byTender.has('Credit')).toBe(false)
  })
})
