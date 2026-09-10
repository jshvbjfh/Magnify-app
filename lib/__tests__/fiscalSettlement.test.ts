/**
 * Issuing the fiscal receipt at settlement.
 *
 * The first thing pinned here is the one that protects every existing venue:
 * on a non-fiscal build this must not run a single query. High 5ive and Sirocco
 * settle bills on this code path every day.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FiscalRefusalError, issueFiscalReceiptForSettlement } from '@/lib/fiscalSettlement'

const LINES = [
  { dishId: 'd1', dishName: 'Plain Bread', dishPrice: 1000, qty: 1 },
  { dishId: 'd2', dishName: 'Wriggly gum', dishPrice: 60, qty: 5 },
]

const BASE = {
  restaurantId: 'r1',
  branchId: 'b1',
  orderId: 'o1',
  orderNumber: 'A-1',
  paymentMethod: 'Cash',
  businessDate: new Date('2026-09-08T00:00:00.000Z'),
  lines: LINES,
}

/** A db that screams if it is touched at all. */
function forbiddenDb() {
  const boom = () => {
    throw new Error('the database must not be touched on a non-fiscal build')
  }
  return new Proxy({}, { get: boom }) as never
}

function fakeDb(overrides: Record<string, unknown> = {}) {
  return {
    restaurant: { findUnique: vi.fn().mockResolvedValue({ name: 'High 5ive', tin: '149047989', sharedStock: false }) },
    branch: {
      findUnique: vi.fn().mockResolvedValue({
        name: 'Main', address: 'Remera', billHeader: null,
        rraBranchCode: '00', sdcId: 'SDC1', mrc: 'MRC1', vsdcUrl: 'http://localhost:8080',
      }),
    },
    dish: { findMany: vi.fn().mockResolvedValue([
      { id: 'd1', taxCategory: 'A' },
      { id: 'd2', taxCategory: 'B' },
    ]) },
    inventoryItem: { findMany: vi.fn().mockResolvedValue([]) },
    fiscalCounter: { upsert: vi.fn(), update: vi.fn() },
    fiscalReceipt: { create: vi.fn().mockImplementation((args: { data: unknown }) => args.data) },
    ...overrides,
  } as never
}

describe('a non-fiscal build', () => {
  it('does nothing at all, and touches no table', async () => {
    delete process.env.RRA_FISCAL_MODE
    await expect(issueFiscalReceiptForSettlement(forbiddenDb(), BASE)).resolves.toBeNull()
  })
})

describe('a fiscal build', () => {
  beforeEach(() => {
    process.env.RRA_FISCAL_MODE = 'on'
  })
  afterEach(() => {
    delete process.env.RRA_FISCAL_MODE
  })

  it('declares nothing for a comped bill', async () => {
    // Nothing was collected, so there is no sale to declare.
    await expect(issueFiscalReceiptForSettlement(forbiddenDb(), { ...BASE, comped: true })).resolves.toBeNull()
  })

  it('declares nothing for an empty bill', async () => {
    await expect(issueFiscalReceiptForSettlement(forbiddenDb(), { ...BASE, lines: [] })).resolves.toBeNull()
  })

  it('refuses to trade when the outlet is not registered', async () => {
    // The failure that matters: NOT "carry on without VAT". Those two look
    // alike from the code and are opposite in law.
    const db = fakeDb({
      branch: {
        findUnique: vi.fn().mockResolvedValue({
          name: 'Main', address: null, billHeader: null,
          rraBranchCode: null, sdcId: null, mrc: null, vsdcUrl: null,
        }),
      },
    })

    await expect(issueFiscalReceiptForSettlement(db, BASE)).rejects.toBeInstanceOf(FiscalRefusalError)
  })

  it('writes the journal row PENDING, never as already issued', async () => {
    // §10 forbids printing before the controller answers, so the row records
    // that a receipt is OWED — it does not assert one was handed over.
    const db = fakeDb()
    const claim = vi.spyOn(await import('@/lib/fiscalCounter'), 'claimFiscalReceiptNumber')
    claim.mockResolvedValue({ typeNumber: 168, totalNumber: 258 })

    const receipt = (await issueFiscalReceiptForSettlement(db, BASE)) as unknown as Record<string, unknown>

    expect(receipt.status).toBe('PENDING')
    expect(receipt.invoiceNumber).toBe(258)
    claim.mockRestore()
  })

  it('declares each line in its own bracket, not all as standard-rated', async () => {
    const db = fakeDb()
    const claim = vi.spyOn(await import('@/lib/fiscalCounter'), 'claimFiscalReceiptNumber')
    claim.mockResolvedValue({ typeNumber: 1, totalNumber: 1 })

    const receipt = (await issueFiscalReceiptForSettlement(db, BASE)) as unknown as Record<string, number>

    // Bread is exempt: 1,000 taxable in A, no tax.
    expect(receipt.taxableAmtA).toBe(1000)
    expect(receipt.taxAmtA).toBe(0)
    // Gum is standard-rated: 300 gross, tax taken out of it.
    expect(receipt.taxAmtB).toBeGreaterThan(0)
    expect(receipt.totalAmount).toBe(1300)
    claim.mockRestore()
  })
})

describe("the guest's TIN", () => {
  beforeEach(() => { process.env.RRA_FISCAL_MODE = 'on' })
  afterEach(() => { delete process.env.RRA_FISCAL_MODE })

  const settle = async (customerTin: string | null | undefined) => {
    const db = fakeDb()
    const claim = vi.spyOn(await import('@/lib/fiscalCounter'), 'claimFiscalReceiptNumber')
    claim.mockResolvedValue({ typeNumber: 1, totalNumber: 1 })
    const receipt = (await issueFiscalReceiptForSettlement(db, { ...BASE, customerTin })) as unknown as Record<string, unknown>
    claim.mockRestore()
    return receipt
  }

  it('declares a nine-digit TIN', async () => {
    expect((await settle('102030405')).customerTin).toBe('102030405')
  })

  it('declares none when the guest is an ordinary individual', async () => {
    // Most bills. RRA's own field is nullable for exactly this reason, and
    // requiring one would stop a waiter settling a walk-in at all.
    expect((await settle(null)).customerTin).toBeNull()
    expect((await settle(undefined)).customerTin).toBeNull()
    expect((await settle('  ')).customerTin).toBeNull()
  })

  it('drops anything that is not nine digits rather than declaring it', async () => {
    // A partial or mistyped TIN attributes the purchase to the wrong taxpayer,
    // which is worse than declaring it against an unidentified buyer.
    for (const value of ['12345', '1020304050', '10203040A', 'RW1020304']) {
      expect((await settle(value)).customerTin).toBeNull()
    }
  })

  it('trims what the till sends', async () => {
    expect((await settle(' 102030405 ')).customerTin).toBe('102030405')
  })
})
