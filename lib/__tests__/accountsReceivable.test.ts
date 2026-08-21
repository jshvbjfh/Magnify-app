/**
 * Unit tests for Accounts Receivable — the page that lists open credit sales.
 *
 * A/R had been reading one table, credit_sales, which only the manual form ever
 * wrote to. Meanwhile the tabs waiters actually take at the till book straight
 * to the ledger and never write that row, so real debt piled up behind a page
 * that showed zero. These tests pin the three roads credit takes into the books:
 *
 *  - 'manual'  a credit_sales row typed into the form;
 *  - 'order'   a bill settled on the Credit tender — the whole order is owed;
 *  - 'buffet'  SIROCCO Y SOL's hotel buffet, where the guest settled the rest of
 *              the bill in cash and only the buffet lines are owed. Scoped to
 *              that one restaurant, and these tests prove nobody else gets it.
 *
 * They also pin the accounting of a collection, which is the half that is easy
 * to get quietly wrong: money arriving against a receivable is a transfer
 * between two asset accounts, never a second helping of revenue.
 *
 * Prisma is mocked. calculateRestaurantOrderTotals is kept REAL so the asserted
 * amounts come from the same (VAT-aware) math production uses.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const getServerSessionMock = vi.hoisted(() => vi.fn())
const recordJournalEntryMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
const prismaMock = vi.hoisted(() => ({
  branch: { findFirst: vi.fn() },
  creditSale: { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  restaurantOrder: { findMany: vi.fn(), findFirst: vi.fn(), updateMany: vi.fn() },
  dish: { findMany: vi.fn() },
  category: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  account: { findFirst: vi.fn(), create: vi.fn() },
  journalEntry: { create: vi.fn() },
  $transaction: vi.fn(),
}))

vi.mock('next-auth/next', () => ({ getServerSession: getServerSessionMock }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

// recordReceivableCollection is kept REAL — its double-entry is the thing under
// test — while the revenue-booking helper beside it is stubbed out.
vi.mock('@/lib/accounting', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>()
  return { ...actual, recordJournalEntry: recordJournalEntryMock }
})

import { GET, PATCH } from '@/app/api/accounts-receivable/route'
import { recordReceivableCollection } from '@/lib/accounting'
import { calculateRestaurantOrderTotals } from '@/lib/restaurantOrders'

// The real SIROCCO Y SOL id — the buffet rule is scoped to this one account on
// purpose (see lib/hotelBuffet.ts), so the tests have to use it to exercise it.
const SIROCCO = 'cmssn2wif000210rcxlzs1jny'
const OTHER_RESTAURANT = 'rest-other'
const MAIN_BRANCH = 'branch-main'
const STATION = 'branch-station'

const BUFFET_DISH = { id: 'dish-buffet', name: 'HOTEL BUFFET', category: 'Breakfast buffet table' }
const COFFEE_DISH = { id: 'dish-coffee', name: 'Cappuccino', category: 'Drinks' }

function grossOf(lines: Array<{ dishPrice: number; qty: number; discountPercent?: number | null }>) {
  return calculateRestaurantOrderTotals(lines).totalAmount
}

function signIn(restaurantId: string, branchId: string | null) {
  getServerSessionMock.mockResolvedValue({ user: { id: 'user-1', restaurantId, branchId } })
}

function request(query = '') {
  return new Request(`http://localhost/api/accounts-receivable${query}`)
}

function patch(body: unknown) {
  return new Request('http://localhost/api/accounts-receivable', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function orderItem(dish: { id: string; name: string }, dishPrice: number, qty: number, discountPercent: number | null = null) {
  return { dishId: dish.id, dishName: dish.name, dishPrice, qty, discountPercent }
}

beforeEach(() => {
  vi.clearAllMocks()

  // Main station by default: the whole-restaurant view.
  prismaMock.branch.findFirst.mockResolvedValue({ id: MAIN_BRANCH, isMain: true })
  prismaMock.creditSale.findMany.mockResolvedValue([])
  prismaMock.restaurantOrder.findMany.mockResolvedValue([])
  prismaMock.dish.findMany.mockResolvedValue([BUFFET_DISH, COFFEE_DISH])
  prismaMock.restaurantOrder.updateMany.mockResolvedValue({ count: 1 })
  prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prismaMock))

  // Category and account provisioning for the real recordReceivableCollection.
  prismaMock.category.findMany.mockResolvedValue(
    ['Income', 'Expense', 'Asset', 'Liability', 'Equity'].map((name) => ({
      id: `cat-${name.toLowerCase()}`, name, type: name.toLowerCase(),
    })),
  )
  prismaMock.account.findFirst.mockImplementation(async ({ where }: { where: { name: string } }) => ({
    id: `acct-${where.name.replace(/\s+/g, '-').toLowerCase()}`,
    name: where.name,
  }))
  prismaMock.journalEntry.create.mockImplementation(async (args: unknown) => args)
})

// Splits the two restaurantOrder.findMany calls GET makes: the Credit-tender
// orders, and the cash-tendered orders carrying a buffet line.
function mockOrders(opts: { credit?: unknown[]; buffet?: unknown[] }) {
  prismaMock.restaurantOrder.findMany.mockImplementation(async ({ where }: { where: { paymentMethod?: unknown } }) => {
    if (where.paymentMethod === 'Credit') return opts.credit ?? []
    return opts.buffet ?? []
  })
}

describe('A/R lists every open credit sale, whatever booked it', () => {
  it('shows a tab settled on the Credit tender — the case that used to be invisible', async () => {
    signIn(OTHER_RESTAURANT, MAIN_BRANCH)
    mockOrders({
      credit: [{
        id: 'ord-1', orderNumber: 'WA-0001', tableName: 'Table 10', totalAmount: 13000,
        paidAt: new Date('2026-08-19T11:51:00Z'), createdAt: new Date('2026-08-19T10:00:00Z'),
        arCustomerName: 'Sebastian', arCustomerPhone: '0788',
        items: [{ dishName: 'Mixed fruit juice', qty: 1 }],
      }],
    })

    const body = await (await GET(request())).json()

    expect(body.totalUnpaid).toBe(13000)
    expect(body.receivables).toHaveLength(1)
    expect(body.receivables[0]).toMatchObject({ customerName: 'Sebastian', totalOwed: 13000, openCount: 1 })
    expect(body.receivables[0].items[0]).toMatchObject({ id: 'order:ord-1', source: 'order' })
  })

  it('groups a customer\'s tabs together and leads with the biggest debtor', async () => {
    signIn(OTHER_RESTAURANT, MAIN_BRANCH)
    prismaMock.creditSale.findMany.mockResolvedValue([{
      id: 'cs-1', description: 'Staff lunch', amount: 4000, saleDate: new Date('2026-08-18T09:00:00Z'),
      customerName: 'Mark', customerPhone: null, branchId: MAIN_BRANCH,
    }])
    mockOrders({
      credit: [
        { id: 'ord-1', orderNumber: 'WA-0001', tableName: null, totalAmount: 13000, paidAt: new Date('2026-08-19T11:51:00Z'), createdAt: new Date(), arCustomerName: 'Sebastian', arCustomerPhone: null, items: [{ dishName: 'Mixed fruit juice', qty: 1 }] },
        { id: 'ord-2', orderNumber: 'WA-0002', tableName: null, totalAmount: 72500, paidAt: new Date('2026-08-21T05:48:00Z'), createdAt: new Date(), arCustomerName: 'Sebastian', arCustomerPhone: '0788', items: [{ dishName: 'Cappuccino', qty: 2 }] },
      ],
    })

    const body = await (await GET(request())).json()

    expect(body.totalUnpaid).toBe(89500)
    expect(body.clientCount).toBe(2)
    expect(body.openCount).toBe(3)
    // Sebastian owes 85,500 against Mark's 4,000, so he sorts first.
    expect(body.receivables.map((r: { customerName: string }) => r.customerName)).toEqual(['Sebastian', 'Mark'])
    expect(body.receivables[0]).toMatchObject({ totalOwed: 85500, openCount: 2, customerPhone: '0788' })
    // The manual row keeps working, under its own source.
    expect(body.receivables[1].items[0]).toMatchObject({ id: 'manual:cs-1', source: 'manual' })
  })

  it('still lists a tab taken without a customer name', async () => {
    signIn(OTHER_RESTAURANT, MAIN_BRANCH)
    mockOrders({
      credit: [{
        id: 'ord-1', orderNumber: 'WA-0001', tableName: null, totalAmount: 5000,
        paidAt: new Date('2026-08-21T05:50:00Z'), createdAt: new Date(), arCustomerName: null, arCustomerPhone: null,
        items: [{ dishName: 'Cappuccino', qty: 1 }],
      }],
    })

    const body = await (await GET(request())).json()

    expect(body.totalUnpaid).toBe(5000)
    expect(body.receivables[0].customerName).toBe('Unnamed tab')
  })
})

describe('the hotel buffet — SIROCCO Y SOL only', () => {
  const buffetOrder = {
    id: 'ord-buffet', orderNumber: 'WA-3478', tableName: 'Takeaway',
    paidAt: new Date('2026-08-19T11:21:00Z'), createdAt: new Date('2026-08-18T11:53:00Z'),
    arCustomerName: null, arCustomerPhone: null,
    items: [orderItem(BUFFET_DISH, 12000, 17)],
  }

  it('owes the buffet lines only, not the whole cash-settled bill', async () => {
    signIn(SIROCCO, MAIN_BRANCH)
    mockOrders({
      buffet: [{ ...buffetOrder, items: [orderItem(BUFFET_DISH, 12000, 17), orderItem(COFFEE_DISH, 5000, 2)] }],
    })

    const body = await (await GET(request())).json()

    // The coffees were paid in cash at the table; only the buffet is owed.
    expect(body.totalUnpaid).toBe(grossOf([{ dishPrice: 12000, qty: 17 }]))
    expect(body.receivables[0]).toMatchObject({ customerName: 'Hotel buffet', openCount: 1 })
    expect(body.receivables[0].items[0]).toMatchObject({ id: 'buffet:ord-buffet', source: 'buffet' })
  })

  it('honours a per-line discount, so the page cannot disagree with the ledger', async () => {
    signIn(SIROCCO, MAIN_BRANCH)
    mockOrders({ buffet: [{ ...buffetOrder, items: [orderItem(BUFFET_DISH, 12000, 10, 25)] }] })

    const body = await (await GET(request())).json()

    expect(body.totalUnpaid).toBe(grossOf([{ dishPrice: 12000, qty: 10, discountPercent: 25 }]))
  })

  it('gives no other restaurant a buffet receivable, even with the same dish name', async () => {
    signIn(OTHER_RESTAURANT, MAIN_BRANCH)
    mockOrders({ buffet: [buffetOrder] })

    const body = await (await GET(request())).json()

    expect(body.totalUnpaid).toBe(0)
    expect(body.receivables).toEqual([])
    // It never even looked: the restaurant check short-circuits before any query.
    expect(prismaMock.dish.findMany).not.toHaveBeenCalled()
  })

  it('ignores a name that merely looks like the buffet dish', async () => {
    signIn(SIROCCO, MAIN_BRANCH)
    prismaMock.dish.findMany.mockResolvedValue([{ id: 'dish-x', name: 'Hotel buffet extra', category: 'Breakfast buffet table' }])
    mockOrders({ buffet: [buffetOrder] })

    const body = await (await GET(request())).json()

    expect(body.totalUnpaid).toBe(0)
  })
})

describe('station scoping', () => {
  it('shows the whole restaurant from Main — an owner means the business, not one till', async () => {
    signIn(SIROCCO, MAIN_BRANCH)
    await GET(request())

    const where = prismaMock.creditSale.findMany.mock.calls[0][0].where
    expect(where.branchId).toBeUndefined()
  })

  it('shows only its own station from a station terminal', async () => {
    signIn(SIROCCO, STATION)
    prismaMock.branch.findFirst.mockResolvedValue({ id: STATION, isMain: false })

    await GET(request())

    expect(prismaMock.creditSale.findMany.mock.calls[0][0].where.branchId).toBe(STATION)
  })

  it('falls back to the whole restaurant when the session carries no station', async () => {
    // A lost branch claim must never be the reason an owner is shown an empty
    // A/R page.
    signIn(SIROCCO, null)

    await GET(request())

    expect(prismaMock.branch.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.creditSale.findMany.mock.calls[0][0].where.branchId).toBeUndefined()
  })
})

describe('collecting on a receivable', () => {
  it('books a transfer, not a second helping of revenue', async () => {
    await recordReceivableCollection(prismaMock as never, {
      restaurantId: SIROCCO,
      branchId: MAIN_BRANCH,
      amount: 13000,
      paymentMethod: 'Cash',
      subject: 'Order WA-0001',
      customerName: 'Sebastian',
    })

    const entry = prismaMock.journalEntry.create.mock.calls[0][0].data
    const [debit, credit] = entry.lines.create
    expect(debit).toMatchObject({ accountId: 'acct-cash', debit: 13000, credit: 0 })
    expect(credit).toMatchObject({ accountId: 'acct-accounts-receivable', debit: 0, credit: 13000 })
    // Revenue was booked when the credit was granted. Booking it again here
    // would count the same plate twice.
    const touched = entry.lines.create.map((l: { accountId: string }) => l.accountId)
    expect(touched).not.toContain('acct-sales')
  })

  it('clears a tab: stamps the order collected and books the whole bill', async () => {
    signIn(OTHER_RESTAURANT, MAIN_BRANCH)
    prismaMock.restaurantOrder.findFirst.mockResolvedValue({
      id: 'ord-1', orderNumber: 'WA-0001', branchId: MAIN_BRANCH, totalAmount: 13000,
      paymentMethod: 'Credit', arCustomerName: 'Sebastian', arCollectedAt: null, items: [],
    })

    const res = await PATCH(patch({ id: 'order:ord-1', paymentMethod: 'Cash' }))

    expect(res.status).toBe(200)
    expect(prismaMock.restaurantOrder.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'ord-1', arCollectedAt: null }) }),
    )
    expect(prismaMock.journalEntry.create.mock.calls[0][0].data.lines.create[0].debit).toBe(13000)
  })

  it('clears a buffet leg at the buffet amount, not the order total', async () => {
    signIn(SIROCCO, MAIN_BRANCH)
    prismaMock.restaurantOrder.findFirst.mockResolvedValue({
      id: 'ord-buffet', orderNumber: 'WA-3478', branchId: MAIN_BRANCH, totalAmount: 999999,
      paymentMethod: 'Cash', arCustomerName: null, arCollectedAt: null,
      items: [orderItem(BUFFET_DISH, 12000, 17), orderItem(COFFEE_DISH, 5000, 2)],
    })

    const res = await PATCH(patch({ id: 'buffet:ord-buffet', paymentMethod: 'Mobile Money' }))

    expect(res.status).toBe(200)
    const [debit] = prismaMock.journalEntry.create.mock.calls[0][0].data.lines.create
    expect(debit.debit).toBe(grossOf([{ dishPrice: 12000, qty: 17 }]))
    expect(debit.accountId).toBe('acct-mobile-money')
  })

  it('treats an id with no source prefix as a manual credit sale, so older clients keep working', async () => {
    signIn(OTHER_RESTAURANT, MAIN_BRANCH)
    prismaMock.creditSale.findFirst.mockResolvedValue({
      id: 'cs-1', description: 'Staff lunch', amount: 4000, customerName: 'Mark', branchId: MAIN_BRANCH,
    })

    const res = await PATCH(patch({ id: 'cs-1', paymentMethod: 'Cash' }))

    expect(res.status).toBe(200)
    expect(prismaMock.creditSale.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cs-1' } }),
    )
  })

  it('refuses to settle a receivable by granting more credit', async () => {
    signIn(OTHER_RESTAURANT, MAIN_BRANCH)

    const res = await PATCH(patch({ id: 'order:ord-1', paymentMethod: 'Credit' }))

    expect(res.status).toBe(400)
    expect(prismaMock.journalEntry.create).not.toHaveBeenCalled()
  })

  it('will not collect the same receivable twice', async () => {
    signIn(OTHER_RESTAURANT, MAIN_BRANCH)
    prismaMock.restaurantOrder.findFirst.mockResolvedValue({
      id: 'ord-1', orderNumber: 'WA-0001', branchId: MAIN_BRANCH, totalAmount: 13000,
      paymentMethod: 'Credit', arCustomerName: 'Sebastian', arCollectedAt: new Date('2026-08-20T10:00:00Z'), items: [],
    })

    const res = await PATCH(patch({ id: 'order:ord-1', paymentMethod: 'Cash' }))

    expect(res.status).toBe(409)
    expect(prismaMock.journalEntry.create).not.toHaveBeenCalled()
  })

  it('books nothing when a racing collection got there first', async () => {
    signIn(OTHER_RESTAURANT, MAIN_BRANCH)
    prismaMock.restaurantOrder.findFirst.mockResolvedValue({
      id: 'ord-1', orderNumber: 'WA-0001', branchId: MAIN_BRANCH, totalAmount: 13000,
      paymentMethod: 'Credit', arCustomerName: 'Sebastian', arCollectedAt: null, items: [],
    })
    // The guarded updateMany matches nothing: someone else stamped it first.
    prismaMock.restaurantOrder.updateMany.mockResolvedValue({ count: 0 })

    await PATCH(patch({ id: 'order:ord-1', paymentMethod: 'Cash' }))

    expect(prismaMock.journalEntry.create).not.toHaveBeenCalled()
  })

  it('refuses to collect against an order that was never on credit', async () => {
    signIn(OTHER_RESTAURANT, MAIN_BRANCH)
    prismaMock.restaurantOrder.findFirst.mockResolvedValue({
      id: 'ord-1', orderNumber: 'WA-0001', branchId: MAIN_BRANCH, totalAmount: 13000,
      paymentMethod: 'Cash', arCustomerName: null, arCollectedAt: null, items: [],
    })

    const res = await PATCH(patch({ id: 'order:ord-1', paymentMethod: 'Cash' }))

    expect(res.status).toBe(400)
    expect(prismaMock.journalEntry.create).not.toHaveBeenCalled()
  })
})
