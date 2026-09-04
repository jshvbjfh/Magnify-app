/**
 * The Z and X daily reports.
 *
 * §18.1 lists twenty items the report must contain. Each is asserted here by
 * clause number, so the clause list can be walked against this file — and so a
 * future edit that drops one fails rather than passing quietly.
 */

import { describe, expect, it } from 'vitest'

import { FISCAL_RECEIPT_TYPES } from '@/lib/fiscalCounter'
import { VSDC_PAYMENT_METHOD } from '@/lib/vsdc/salesPayload'
import {
  buildDailyReport,
  renderDailyReportAsText,
  summarizeDailyReport,
  type DailyReportInput,
} from '@/lib/vsdc/dailyReport'

const HEADER = {
  tradeName: 'High 5ive',
  tin: '999999991',
  mrc: 'AAACC123456',
  cisDesignation: 'Magnify 1.1.50',
  date: '04/09/2026',
  time: '23:15:00',
}

/** Two standard-rated sales, one exempt sale, one refund. */
const DAY: DailyReportInput = {
  ...HEADER,
  kind: 'Z',
  periodLabel: '04/09/2026 00:00:00 - 23:59:59',
  openingDeposit: 50000,
  incompleteSalesCount: 2,
  otherReductions: [{ label: 'Comped bills', amount: 12000 }],
  receipts: [
    {
      receiptType: FISCAL_RECEIPT_TYPES.NORMAL_SALE,
      totalAmount: 5000,
      taxableByCategory: { B: 5000 },
      taxByCategory: { B: 762.71 },
      itemCount: 3,
      discountTotal: 500,
      paymentTypeCode: VSDC_PAYMENT_METHOD.CASH,
    },
    {
      receiptType: FISCAL_RECEIPT_TYPES.NORMAL_SALE,
      totalAmount: 11800,
      taxableByCategory: { B: 11800 },
      taxByCategory: { B: 1800 },
      itemCount: 5,
      paymentTypeCode: VSDC_PAYMENT_METHOD.MOBILE_MONEY,
    },
    {
      receiptType: FISCAL_RECEIPT_TYPES.NORMAL_SALE,
      totalAmount: 2000,
      taxableByCategory: { A: 2000 },
      taxByCategory: { A: 0 },
      itemCount: 1,
      paymentTypeCode: VSDC_PAYMENT_METHOD.CASH,
    },
    {
      receiptType: FISCAL_RECEIPT_TYPES.REFUND,
      totalAmount: 5000,
      taxableByCategory: { B: 5000 },
      taxByCategory: { B: 762.71 },
      itemCount: 3,
      paymentTypeCode: VSDC_PAYMENT_METHOD.CASH,
    },
    { receiptType: FISCAL_RECEIPT_TYPES.COPY, totalAmount: 5000 },
    { receiptType: FISCAL_RECEIPT_TYPES.TRAINING, totalAmount: 1000 },
    { receiptType: FISCAL_RECEIPT_TYPES.PROFORMA, totalAmount: 7000 },
    { receiptType: FISCAL_RECEIPT_TYPES.PROFORMA, totalAmount: 3000 },
  ],
}

const text = renderDailyReportAsText(DAY)
const s = summarizeDailyReport(DAY)

describe('§18.1.1-.4 — identity and heading', () => {
  it('carries trade name and TIN', () => {
    expect(text).toContain('High 5ive')
    expect(text).toContain('TIN: 999999991')
  })

  it('says which report it is, at double size', () => {
    expect(text).toContain('Z DAILY REPORT')
    const heading = buildDailyReport(DAY).find((l) => l.kind === 'text' && l.text === 'Z DAILY REPORT')
    // An X mistaken for a Z closes a day by accident.
    expect(heading).toMatchObject({ scale: 2 })
  })

  it('carries the date, time, CIS designation and MRC', () => {
    expect(text).toContain('DATE: 04/09/2026 TIME: 23:15:00')
    expect(text).toContain('CIS: Magnify 1.1.50')
    expect(text).toContain('MRC: AAACC123456')
  })

  it('distinguishes an X report from a Z', () => {
    const x = renderDailyReportAsText({ ...DAY, kind: 'X', periodLabel: 'since last Z' })
    expect(x).toContain('X DAILY REPORT')
    expect(x).not.toContain('Z DAILY REPORT')
  })
})

describe('§18.1.5-.9 — sales and refunds', () => {
  it('counts and totals sales', () => {
    expect(s.salesCount).toBe(3)
    expect(s.salesTotal).toBe(18800)
    expect(text).toMatch(/SALES \(NS\)\s+3/)
    expect(text).toMatch(/TOTAL SALES\s+18800\.00/)
  })

  it('counts and totals refunds, printed negative', () => {
    expect(s.refundCount).toBe(1)
    expect(s.refundTotal).toBe(5000)
    expect(text).toMatch(/TOTAL REFUNDS\s+-5000\.00/)
  })

  it('does not net refunds away against sales', () => {
    // A day of equal sales and refunds must not report as a day with no trade.
    const wash = summarizeDailyReport({
      ...DAY,
      receipts: [
        { receiptType: FISCAL_RECEIPT_TYPES.NORMAL_SALE, totalAmount: 5000, taxableByCategory: { B: 5000 } },
        { receiptType: FISCAL_RECEIPT_TYPES.REFUND, totalAmount: 5000, taxableByCategory: { B: 5000 } },
      ],
    })

    expect(wash.salesTotal).toBe(5000)
    expect(wash.refundTotal).toBe(5000)
    expect(wash.netTotal).toBe(0)
  })
})

describe('§18.1.10-.11 — per rate, sales and refunds apart', () => {
  it('splits taxable and tax by bracket', () => {
    expect(s.taxableSales.B).toBe(16800)
    expect(s.taxSales.B).toBe(2562.71)
    expect(s.taxableSales.A).toBe(2000)
    expect(s.taxSales.A).toBe(0)
  })

  it('keeps refund figures separate from sales figures', () => {
    expect(s.taxableRefunds.B).toBe(5000)
    expect(s.taxRefunds.B).toBe(762.71)
    expect(text).toContain('TAXABLE B-18.00% (NS)')
    expect(text).toContain('TAXABLE B-18.00% (NR)')
  })

  it('prints an exempt bracket as A-EX', () => {
    expect(text).toContain('TAXABLE A-EX (NS)')
  })

  it('omits a bracket nothing touched', () => {
    expect(text).not.toContain('C-EX')
    expect(text).not.toContain('TAXABLE D')
  })
})

describe('§18.1.12-.16 — float, items, and the non-sale types', () => {
  it('reports the opening deposit', () => {
    expect(text).toMatch(/OPENING DEPOSIT\s+50000\.00/)
  })

  it('counts items sold across sales only', () => {
    // 3 + 5 + 1 from the sales; the refund's 3 are not "sold".
    expect(s.itemsSold).toBe(9)
    expect(text).toMatch(/ITEMS SOLD\s+9/)
  })

  it('counts and totals copies, training and proforma separately', () => {
    expect(s.copies).toEqual({ count: 1, amount: 5000 })
    expect(s.training).toEqual({ count: 1, amount: 1000 })
    expect(s.proforma).toEqual({ count: 2, amount: 10000 })
    expect(text).toMatch(/COPIES \(CS\)\s+1 \/ 5000\.00/)
    expect(text).toMatch(/PROFORMA \(PS\)\s+2 \/ 10000\.00/)
  })

  it('excludes copies, training and proforma from sales totals', () => {
    // None of them is a sale. Counting them would inflate the day.
    expect(s.salesTotal).toBe(18800)
  })
})

describe('§18.1.17 — by means of payment', () => {
  it('splits each tender between sales and refunds', () => {
    expect(s.byPayment.get(VSDC_PAYMENT_METHOD.CASH)).toEqual({ sales: 7000, refunds: 5000 })
    expect(s.byPayment.get(VSDC_PAYMENT_METHOD.MOBILE_MONEY)).toEqual({ sales: 11800, refunds: 0 })
    expect(text).toMatch(/CASH \(NS\)\s+7000\.00/)
    expect(text).toMatch(/CASH \(NR\)\s+-5000\.00/)
    expect(text).toMatch(/MOBILE MONEY \(NS\)\s+11800\.00/)
  })

  it('files an unknown tender under OTHER rather than dropping it', () => {
    const r = summarizeDailyReport({
      ...DAY,
      receipts: [{ receiptType: FISCAL_RECEIPT_TYPES.NORMAL_SALE, totalAmount: 900, paymentTypeCode: null }],
    })

    expect(r.byPayment.get(VSDC_PAYMENT_METHOD.OTHER)).toEqual({ sales: 900, refunds: 0 })
  })
})

describe('§18.1.18-.20 — reductions and incomplete sales', () => {
  it('totals every discount given', () => {
    expect(s.discountTotal).toBe(500)
    expect(text).toMatch(/DISCOUNTS\s+-500\.00/)
  })

  it('names other reductions individually', () => {
    expect(text).toMatch(/COMPED BILLS\s+-12000\.00/)
  })

  it('counts incomplete sales', () => {
    expect(text).toMatch(/INCOMPLETE SALES\s+2/)
  })
})

describe('reconciliation', () => {
  it('nets sales against refunds for the closing figure', () => {
    expect(s.netTotal).toBe(13800)
    expect(text).toMatch(/NET TOTAL\s+13800\.00/)
  })

  it('produces a report from an empty day without throwing', () => {
    // A venue that opened and took nothing still has to close its day.
    const quiet = renderDailyReportAsText({ ...DAY, receipts: [], otherReductions: [] })

    expect(quiet).toContain('Z DAILY REPORT')
    expect(quiet).toMatch(/TOTAL SALES\s+0\.00/)
    expect(quiet).toMatch(/NET TOTAL\s+0\.00/)
  })
})
