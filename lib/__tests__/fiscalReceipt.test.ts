/**
 * The fiscal receipt, checked against the sample receipts printed in RRA's CIS
 * technical specification (§13.1 for a sale, §13.2 for a refund).
 *
 * Their samples are the standard, not our reading of the prose around them.
 */

import { describe, expect, it } from 'vitest'

import { FISCAL_RECEIPT_TYPES } from '@/lib/fiscalCounter'
import {
  buildFiscalReceipt,
  buildQrPayload,
  groupInFours,
  renderReceiptAsText,
  type FiscalReceiptInput,
} from '@/lib/vsdc/fiscalReceipt'

const VSDC = {
  sdcId: 'SDC001000001',
  date: '25/5/2012',
  time: '11:07:35',
  receiptNumberForType: 168,
  receiptNumberTotal: 258,
  internalData: 'TE68SLA234J5EAV3N56988LJQ7',
  receiptSignature: 'V249J39CFJ48HE2W',
}

/** The bill printed in §13.1: exempt bread, discounted gouda, gum. */
const SALE: FiscalReceiptInput = {
  receiptType: FISCAL_RECEIPT_TYPES.NORMAL_SALE,
  tradeName: 'Trade Name',
  address: 'Address, City',
  tin: '000000000',
  mrc: 'AAACC123456',
  topMessage: 'Welcome to our shop',
  bottomMessage: 'THANK YOU',
  customerTin: '000000000',
  lines: [
    { name: 'Plain Bread', unitPrice: 1000, qty: 1, taxCategory: 'A', chargedAmount: 1000 },
    { name: 'Gouda cheese', unitPrice: 33600, qty: 0.2, discountPercent: 25, taxCategory: 'B', chargedAmount: 5040 },
    { name: 'Wriggly gum', unitPrice: 60, qty: 5, taxCategory: 'B', chargedAmount: 300 },
  ],
  taxBreakdown: [
    { category: 'A', ratePercent: 0, grossAmount: 1000, taxAmount: 0 },
    { category: 'B', ratePercent: 18, grossAmount: 5340, taxAmount: 814.58 },
  ],
  totalAmount: 6340,
  totalTaxAmount: 814.58,
  paymentLabel: 'Cash',
  cisReceiptNumber: '152',
  cisDate: '25/5/2012',
  cisTime: '11:09:32',
  vsdc: VSDC,
}

function textOf(input: FiscalReceiptInput) {
  return renderReceiptAsText(buildFiscalReceipt(input))
}

describe("the specification's sample sale (§13.1)", () => {
  const text = textOf(SALE)

  it('prints the taxpayer header with the TIN', () => {
    expect(text).toContain('Trade Name')
    expect(text).toContain('Address, City')
    expect(text).toContain('TIN: 000000000')
  })

  it('prints each item as description then price, quantity, amount and tax letter', () => {
    expect(text).toContain('Plain Bread')
    expect(text).toContain('1000.00x 1')
    expect(text).toContain('1000.00A')
    expect(text).toContain('33600.00x 0.2')
    expect(text).toContain('6720.00B')
  })

  it('prints the discount as a percentage and the discounted amount', () => {
    // The spec shows "discount -25%  5040.00" — the resulting price, not the
    // amount taken off.
    expect(text).toContain('discount -25%')
    expect(text).toContain('5040.00')
  })

  it('prints the totals exactly as the sample does', () => {
    expect(text).toMatch(/TOTAL\s+6340\.00/)
    expect(text).toMatch(/TOTAL A-EX\s+1000\.00/)
    expect(text).toMatch(/TOTAL B-18\.00%\s+5340\.00/)
    expect(text).toMatch(/TOTAL TAX B\s+814\.58/)
    expect(text).toMatch(/TOTAL TAX\s+814\.58/)
  })

  it('prints the tender and the item count', () => {
    expect(text).toMatch(/CASH\s+6340\.00/)
    expect(text).toMatch(/ITEMS NUMBER\s+3/)
  })

  it('prints the SDC block with both counters and the receipt type', () => {
    expect(text).toContain('SDC INFORMATION')
    expect(text).toContain('Date: 25/5/2012 Time: 11:07:35')
    expect(text).toContain('SDC ID: SDC001000001')
    expect(text).toContain('RECEIPT NUMBER: 168/258  NS')
  })

  it('groups internal data and signature in fours', () => {
    expect(text).toContain('TE68-SLA2-34J5-EAV3-N569-88LJ-Q7')
    expect(text).toContain('V249-J39C-FJ48-HE2W')
  })

  it('prints the CIS block after the SDC block', () => {
    expect(text).toContain('RECEIPT NUMBER: 152')
    expect(text).toContain('MRC: AAACC123456')
    // The CIS number comes after the VSDC one, as the sample sets it.
    expect(text.indexOf('RECEIPT NUMBER: 152')).toBeGreaterThan(text.indexOf('SDC ID:'))
  })

  it('prints the RRA logo (§7.29)', () => {
    expect(text).toContain('[RRA LOGO]')
  })

  it('carries no watermark or disclaimer on a real sale', () => {
    expect(text).not.toContain('WATERMARK')
    expect(text).not.toContain('NOT AN OFFICIAL RECEIPT')
  })
})

describe('refunds (§13.2)', () => {
  const refund = textOf({
    ...SALE,
    receiptType: FISCAL_RECEIPT_TYPES.REFUND,
    refundedReceiptNumber: '168',
    cisReceiptNumber: '153',
  })

  it('names the receipt it reverses', () => {
    expect(refund).toContain('REFUND')
    expect(refund).toContain('REF. NORMAL RECEIPT#: 168')
    expect(refund).toContain('REFUND IS APPROVED ONLY FOR')
    expect(refund).toContain('ORIGINAL SALES RECEIPT')
  })

  it('prints every figure negative — lines, totals, tax and tender', () => {
    expect(refund).toMatch(/TOTAL\s+-6340\.00/)
    expect(refund).toMatch(/TOTAL B-18\.00%\s+-5340\.00/)
    expect(refund).toMatch(/TOTAL TAX B\s+-814\.58/)
    expect(refund).toMatch(/CASH\s+-6340\.00/)
    expect(refund).toContain('-1000.00A')
  })

  it('labels the receipt number NR', () => {
    expect(refund).toContain('168/258  NR')
  })
})

describe('copies, training and proforma (§11)', () => {
  it.each([
    [FISCAL_RECEIPT_TYPES.COPY, 'COPY'],
    [FISCAL_RECEIPT_TYPES.TRAINING, 'TRAINING'],
    [FISCAL_RECEIPT_TYPES.PROFORMA, 'PROFORMA'],
  ])('marks %s above the items, as a watermark, and with the disclaimer', (type, label) => {
    const lines = buildFiscalReceipt({ ...SALE, receiptType: type })
    const text = renderReceiptAsText(lines)

    expect(text).toContain(`[WATERMARK: ${label}]`)
    expect(text).toContain(label)
    expect(text).toContain('THIS IS NOT AN OFFICIAL RECEIPT')

    // "at least twice bigger than the text that indicates the amount"
    const disclaimer = lines.find((l) => l.kind === 'text' && l.text === 'THIS IS NOT AN OFFICIAL RECEIPT')
    expect(disclaimer).toMatchObject({ scale: 2 })
  })

  it('places the designation between the header and the items', () => {
    const text = renderReceiptAsText(buildFiscalReceipt({ ...SALE, receiptType: FISCAL_RECEIPT_TYPES.COPY }))

    expect(text.indexOf('COPY')).toBeGreaterThan(text.indexOf('TIN: 000000000'))
    expect(text.indexOf('COPY')).toBeLessThan(text.indexOf('Plain Bread'))
  })

  it('does not sign a training or proforma ticket (§6.3.6)', () => {
    for (const type of [FISCAL_RECEIPT_TYPES.TRAINING, FISCAL_RECEIPT_TYPES.PROFORMA]) {
      const text = renderReceiptAsText(buildFiscalReceipt({ ...SALE, receiptType: type, vsdc: null }))

      expect(text).not.toContain('SDC INFORMATION')
      expect(text).not.toContain('Receipt Signature')
      // But it is still marked, and still carries the logo.
      expect(text).toContain('THIS IS NOT AN OFFICIAL RECEIPT')
      expect(text).toContain('[RRA LOGO]')
    }
  })
})

describe('groupInFours (§7.24.5–.6)', () => {
  it('dashes after every fourth character', () => {
    expect(groupInFours('TE68SLA234J5EAV3N56988LJQ7')).toBe('TE68-SLA2-34J5-EAV3-N569-88LJ-Q7')
    expect(groupInFours('V249J39CFJ48HE2W')).toBe('V249-J39C-FJ48-HE2W')
  })

  it('leaves a short trailing group as it is rather than padding it', () => {
    expect(groupInFours('ABCDE')).toBe('ABCD-E')
  })

  it('is idempotent on an already-grouped string', () => {
    expect(groupInFours('V249-J39C-FJ48-HE2W')).toBe('V249-J39C-FJ48-HE2W')
  })

  it('returns empty for nothing', () => {
    expect(groupInFours(null)).toBe('')
    expect(groupInFours('')).toBe('')
  })
})

describe('QR payload (§7.24.7)', () => {
  it('is composed exactly as the clause specifies', () => {
    // invoice_date(ddmmyyyy)#time(hhmmss)#sdc number#sdc_receipt_number
    // #internal_data#receipt_signature
    expect(buildQrPayload(VSDC)).toBe(
      '2552012#110735#SDC001000001#168#TE68SLA234J5EAV3N56988LJQ7#V249J39CFJ48HE2W',
    )
  })

  it('strips the dashes the printed form adds', () => {
    const payload = buildQrPayload({ ...VSDC, internalData: 'TE68-SLA2-34J5', receiptSignature: 'V249-J39C' })

    expect(payload).toContain('#TE68SLA234J5#')
    expect(payload.endsWith('#V249J39C')).toBe(true)
  })

  it('carries the date without separators, unlike the printed SDC block', () => {
    const payload = buildQrPayload({ ...VSDC, date: '25/05/2012' })

    expect(payload.startsWith('25052012#')).toBe(true)
  })
})
