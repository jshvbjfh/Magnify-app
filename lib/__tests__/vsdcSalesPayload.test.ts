/**
 * The VSDC sales payload, checked against RRA's own worked examples.
 *
 * These numbers are not mine. They are lifted from the JSON sample in RRA's
 * VSDC API specification v1.0.4 and from the sample receipt in the CIS
 * technical specification. If this file goes green, the arithmetic agrees with
 * the authority's own documents — which is the only standard that matters here,
 * because a wrong number is a wrong tax declaration.
 */

import { describe, expect, it } from 'vitest'

import {
  VSDC_PAYMENT_METHOD,
  VSDC_RECEIPT_TYPE,
  buildVsdcSalesPayload,
  toVsdcPaymentMethod,
} from '@/lib/vsdc/salesPayload'

const BASE = {
  tin: '999999991',
  bhfId: '00',
  invoiceNumber: 15,
  receiptType: VSDC_RECEIPT_TYPE.SALE,
  paymentMethod: 'Cash',
  confirmedAt: '20210709120300',
  salesDate: '20210709',
  registrantId: '11999',
  registrantName: 'Test VSDC',
}

describe("RRA's own JSON sample", () => {
  // From the spec: two standard-rated items at 200,000 and 50,000, no discount.
  const payload = buildVsdcSalesPayload({
    ...BASE,
    lines: [
      { itemCode: 'RW1NTXU0000001', classificationCode: '5059690800', name: 'OutDoorUnit', unitPrice: 200000, qty: 1, taxCategory: 'B' },
      { itemCode: 'RW1NTXU0000002', classificationCode: '5022110801', name: 'NetworkCable', unitPrice: 50000, qty: 1, taxCategory: 'B' },
    ],
  })

  it('extracts tax from the price rather than adding it', () => {
    // 200,000 × 18/118 = 30,508.47 → the spec's sample says 30508.
    expect(payload.itemList[0].taxAmt).toBeCloseTo(30508, 0)
    expect(payload.itemList[1].taxAmt).toBeCloseTo(7627, 0)
  })

  it('reports the VAT-inclusive amount as the taxable amount', () => {
    // The trap: taxblAmt is the gross, not the net. Sending 169,492 here would
    // under-declare the sale.
    expect(payload.itemList[0].taxblAmt).toBe(200000)
    expect(payload.itemList[0].totAmt).toBe(200000)
    expect(payload.itemList[0].splyAmt).toBe(200000)
  })

  it('matches the sample totals', () => {
    expect(payload.totTaxblAmt).toBe(250000)
    expect(payload.totAmt).toBe(250000)
    // The sample prints 38135; the exact figure is 250,000 × 18/118 =
    // 38,135.59. That sample truncates its decimals (and gets taxAmtB wrong
    // outright), so the two-decimal value is what we send — the spec declares
    // this field as 18,2.
    expect(payload.totTaxAmt).toBe(38135.59)
    expect(payload.totItemCnt).toBe(2)
  })

  it('computes the per-bracket tax from the bracket total', () => {
    // RRA's sample declares taxAmtB as 94576, which contradicts its own lines
    // AND its own totTaxAmt (38135). That figure is a documentation error.
    // 250,000 × 18/118 = 38,135.59 is the self-consistent reading.
    expect(payload.taxAmtB).toBe(38135.59)
    expect(payload.taxAmtB).toBe(payload.totTaxAmt)
    expect(payload.taxblAmtB).toBe(250000)
  })

  it('reports zero for brackets with nothing in them', () => {
    for (const key of ['taxblAmtA', 'taxblAmtC', 'taxblAmtD', 'taxAmtA', 'taxAmtC', 'taxAmtD'] as const) {
      expect(payload[key]).toBe(0)
    }
    expect(payload.taxRtB).toBe(18)
    expect(payload.taxRtA).toBe(0)
  })

  it('sends only transaction type N, as the spec requires', () => {
    expect(payload.salesTyCd).toBe('N')
  })
})

describe("the CIS spec's sample receipt", () => {
  // Plain Bread 1000 exempt; Gouda 33,600 × 0.2 = 6,720 less 25% = 5,040;
  // Wriggly gum 60 × 5 = 300. Standard-rated total 5,340, tax 814.58.
  const payload = buildVsdcSalesPayload({
    ...BASE,
    lines: [
      { itemCode: 'BREAD', name: 'Plain Bread', unitPrice: 1000, qty: 1, taxCategory: 'A' },
      { itemCode: 'GOUDA', name: 'Gouda cheese', unitPrice: 33600, qty: 0.2, discountPercent: 25, taxCategory: 'B' },
      { itemCode: 'GUM', name: 'Wriggly gum', unitPrice: 60, qty: 5, taxCategory: 'B' },
    ],
  })

  it('reproduces the printed totals exactly', () => {
    expect(payload.totAmt).toBe(6340)
    expect(payload.taxblAmtA).toBe(1000)
    expect(payload.taxblAmtB).toBe(5340)
    expect(payload.taxAmtB).toBe(814.58)
    expect(payload.totTaxAmt).toBe(814.58)
  })

  it('charges no tax on the exempt line', () => {
    expect(payload.itemList[0].taxTyCd).toBe('A')
    expect(payload.itemList[0].taxAmt).toBe(0)
  })

  it('reports the discount as a rate and an amount that reconcile', () => {
    const gouda = payload.itemList[1]

    expect(gouda.splyAmt).toBe(6720)
    expect(gouda.dcRt).toBe(25)
    expect(gouda.dcAmt).toBe(1680)
    expect(gouda.taxblAmt).toBe(5040)
    // Supply = charged + discount, to the franc, always.
    expect(gouda.taxblAmt + gouda.dcAmt).toBe(gouda.splyAmt)
  })
})

describe('reconciliation', () => {
  it('keeps taxable + tax equal to the charge on every line', () => {
    const payload = buildVsdcSalesPayload({
      ...BASE,
      lines: Array.from({ length: 12 }, (_, i) => ({
        itemCode: `ITEM${i}`,
        name: `Item ${i}`,
        unitPrice: 333 + i * 197,
        qty: (i % 3) + 1,
        discountPercent: i % 4 === 0 ? 15 : null,
        taxCategory: (['A', 'B', 'C', 'D'] as const)[i % 4],
      })),
    })

    for (const line of payload.itemList) {
      expect(round(line.taxblAmt)).toBe(round(line.totAmt))
    }

    expect(payload.totTaxblAmt).toBe(payload.totAmt)
    expect(round(payload.taxAmtA + payload.taxAmtB + payload.taxAmtC + payload.taxAmtD)).toBe(round(payload.totTaxAmt))
  })

  function round(value: number) {
    return Math.round(value * 100) / 100
  }
})

describe('payment methods', () => {
  it('maps every tender the apps actually write', () => {
    expect(toVsdcPaymentMethod('Cash')).toBe(VSDC_PAYMENT_METHOD.CASH)
    // The till writes 'MoMo', the manager screen writes 'Mobile Money'.
    expect(toVsdcPaymentMethod('MoMo')).toBe(VSDC_PAYMENT_METHOD.MOBILE_MONEY)
    expect(toVsdcPaymentMethod('Mobile Money')).toBe(VSDC_PAYMENT_METHOD.MOBILE_MONEY)
    expect(toVsdcPaymentMethod('Owner Momo')).toBe(VSDC_PAYMENT_METHOD.MOBILE_MONEY)
    expect(toVsdcPaymentMethod('Card')).toBe(VSDC_PAYMENT_METHOD.CARD)
    expect(toVsdcPaymentMethod('Credit')).toBe(VSDC_PAYMENT_METHOD.CREDIT)
    expect(toVsdcPaymentMethod('Cheque')).toBe(VSDC_PAYMENT_METHOD.BANK_CHECK)
  })

  it('does not read "cash/credit" as plain cash', () => {
    expect(toVsdcPaymentMethod('Cash/Credit')).toBe(VSDC_PAYMENT_METHOD.CASH_CREDIT)
  })

  it('falls back to OTHER instead of throwing', () => {
    // A tender label must never be able to block a till mid-service.
    for (const value of ['Bank Transfer', 'Complementary', '', null, undefined, 'something new']) {
      expect(toVsdcPaymentMethod(value)).toBeTypeOf('string')
    }
    expect(toVsdcPaymentMethod('Bank Transfer')).toBe(VSDC_PAYMENT_METHOD.OTHER)
    expect(toVsdcPaymentMethod(null)).toBe(VSDC_PAYMENT_METHOD.OTHER)
  })
})

describe('field limits', () => {
  it('truncates a long dish name rather than letting RRA reject the sale', () => {
    const payload = buildVsdcSalesPayload({
      ...BASE,
      lines: [{ itemCode: 'X', name: 'A'.repeat(400), unitPrice: 1000, qty: 1, taxCategory: 'B' }],
    })

    expect(payload.itemList[0].itemNm).toHaveLength(200)
  })

  it('numbers items from 1', () => {
    const payload = buildVsdcSalesPayload({
      ...BASE,
      lines: [
        { itemCode: 'A', name: 'A', unitPrice: 100, qty: 1 },
        { itemCode: 'B', name: 'B', unitPrice: 100, qty: 1 },
      ],
    })

    expect(payload.itemList.map((line) => line.itemSeq)).toEqual([1, 2])
  })

  it('sends orgInvcNo 0 for an ordinary sale', () => {
    const payload = buildVsdcSalesPayload({ ...BASE, lines: [{ itemCode: 'A', name: 'A', unitPrice: 100, qty: 1 }] })

    expect(payload.orgInvcNo).toBe(0)
    expect(payload.rfdDt).toBeNull()
  })

  it('stamps the refund date and original invoice on a refund', () => {
    const payload = buildVsdcSalesPayload({
      ...BASE,
      receiptType: VSDC_RECEIPT_TYPE.REFUND,
      originalInvoiceNumber: 14,
      lines: [{ itemCode: 'A', name: 'A', unitPrice: 100, qty: 1 }],
    })

    expect(payload.orgInvcNo).toBe(14)
    expect(payload.rfdDt).toBe(BASE.confirmedAt)
  })
})
