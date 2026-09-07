/**
 * The join between one of Magnify's bills and the receipt RRA specifies.
 *
 * The layout itself is covered by fiscalReceipt.test.ts. What is pinned here is
 * the translation: that an order's lines, discounts and brackets arrive on the
 * page as the figures RRA's own sample prints, and that an unsigned type stays
 * unsigned however it is called.
 */

import { describe, it, expect } from 'vitest'
import { buildReceiptInputFromOrder, splitDateTime } from '@/lib/fiscalReceiptBuilder'
import { FISCAL_RECEIPT_TYPES } from '@/lib/fiscalCounter'
import { buildFiscalReceipt, renderReceiptAsText } from '@/lib/vsdc/fiscalReceipt'

const OUTLET = {
  tradeName: 'High 5ive',
  address: 'Rukiri I, Remera, Gasabo',
  tin: '149047989',
  mrc: 'MRC0012345',
}

// Clause 13.1's own bill.
const ORDER = {
  orderNumber: 'A-1042',
  createdAt: new Date('2026-09-08T10:30:00.000Z'),
  paymentMethod: 'Cash',
  items: [
    { dishName: 'Plain Bread', dishPrice: 1000, qty: 1, taxCategory: 'A' },
    { dishName: 'Gouda cheese', dishPrice: 33600, qty: 0.2, discountPercent: 25, taxCategory: 'B' },
    { dishName: 'Wriggly gum', dishPrice: 60, qty: 5, taxCategory: 'B' },
  ],
}

const proforma = () =>
  buildReceiptInputFromOrder({
    order: ORDER,
    outlet: OUTLET,
    receiptType: FISCAL_RECEIPT_TYPES.PROFORMA,
  })

describe('the figures reaching the page', () => {
  const input = proforma()

  it("reproduces RRA's printed total", () => {
    expect(input.totalAmount).toBe(6340)
  })

  it('takes tax from the bracket, so the receipt reads 814.58', () => {
    expect(input.totalTaxAmount).toBe(814.58)
    const b = input.taxBreakdown.find((row) => row.category === 'B')!
    expect(b.grossAmount).toBe(5340)
    expect(b.taxAmount).toBe(814.58)
  })

  it('shows the exempt bracket carrying no tax', () => {
    const a = input.taxBreakdown.find((row) => row.category === 'A')!
    expect(a.grossAmount).toBe(1000)
    expect(a.taxAmount).toBe(0)
    expect(a.ratePercent).toBe(0)
  })

  it('prints only the brackets on the bill, in order (§7.22)', () => {
    expect(input.taxBreakdown.map((row) => row.category)).toEqual(['A', 'B'])
  })

  it('charges the discounted amount, not the menu price', () => {
    // 33,600 × 0.2 = 6,720, less 25% = 5,040.
    expect(input.lines[1].chargedAmount).toBe(5040)
    expect(input.lines[1].unitPrice).toBe(33600)
  })

  it('makes the lines add up to the total on the same page', () => {
    const summed = input.lines.reduce((sum, line) => sum + line.chargedAmount, 0)
    expect(Math.round(summed * 100) / 100).toBe(input.totalAmount)
  })

  it('defaults an unclassified dish to standard-rated, never exempt', () => {
    const unclassified = buildReceiptInputFromOrder({
      order: { ...ORDER, items: [{ dishName: 'Mystery', dishPrice: 1180, qty: 1, taxCategory: null }] },
      outlet: OUTLET,
      receiptType: FISCAL_RECEIPT_TYPES.PROFORMA,
    })
    expect(unclassified.lines[0].taxCategory).toBe('B')
    expect(unclassified.totalTaxAmount).toBeGreaterThan(0)
  })
})

describe('unsigned types stay unsigned (§6.3.6)', () => {
  const signature = {
    sdcId: 'SDC001000001',
    date: '08/09/2026',
    time: '10:30:00',
    receiptNumberForType: 168,
    receiptNumberTotal: 258,
    internalData: 'TE68SLA234J5EAV3',
    receiptSignature: 'XYZ1ABC2DEF3GHI4',
  }

  it('drops a signature handed to a proforma', () => {
    // Even when a caller passes one, which is the failure worth preventing:
    // a signed proforma is a receipt claiming to be a sale.
    const input = buildReceiptInputFromOrder({
      order: ORDER,
      outlet: OUTLET,
      receiptType: FISCAL_RECEIPT_TYPES.PROFORMA,
      vsdc: signature,
    })
    expect(input.vsdc).toBeNull()
  })

  it('drops a signature handed to a training ticket', () => {
    const input = buildReceiptInputFromOrder({
      order: ORDER,
      outlet: OUTLET,
      receiptType: FISCAL_RECEIPT_TYPES.TRAINING,
      vsdc: signature,
    })
    expect(input.vsdc).toBeNull()
  })

  it('keeps a signature on a normal sale', () => {
    const input = buildReceiptInputFromOrder({
      order: ORDER,
      outlet: OUTLET,
      receiptType: FISCAL_RECEIPT_TYPES.NORMAL_SALE,
      vsdc: signature,
    })
    expect(input.vsdc).toEqual(signature)
  })
})

describe('what the paper says', () => {
  const text = renderReceiptAsText(buildFiscalReceipt(proforma()))

  it('carries the trade name, address and TIN (§13.1)', () => {
    expect(text).toContain('High 5ive')
    expect(text).toContain('Rukiri I, Remera, Gasabo')
    expect(text).toContain('149047989')
  })

  it('names itself a proforma, so it cannot be mistaken for a sale (§11)', () => {
    expect(text).toContain('PROFORMA')
  })

  it('prints money to two decimals (§7.5)', () => {
    expect(text).toMatch(/6340\.00/)
    expect(text).toMatch(/814\.58/)
  })

  it('shows no SDC signature block', () => {
    expect(text).not.toContain('SDC ID')
  })
})

describe('splitDateTime', () => {
  it('formats as dd/mm/yyyy and hh:mm:ss', () => {
    expect(splitDateTime(new Date('2026-09-08T10:30:05.000Z'))).toEqual({
      date: '08/09/2026',
      time: '10:30:05',
    })
  })

  it('falls back to now rather than printing NaN on a receipt', () => {
    const result = splitDateTime('not a date')
    expect(result.date).toMatch(/^\d{2}\/\d{2}\/\d{4}$/)
    expect(result.time).toMatch(/^\d{2}:\d{2}:\d{2}$/)
  })
})
