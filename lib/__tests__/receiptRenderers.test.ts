/**
 * The two printer adapters.
 *
 * What matters most here is that they agree. The layout is decided once in
 * fiscalReceipt.ts precisely so thermal and HTML cannot drift — that already
 * happened once with discounts, which printed on screen and not on paper for
 * weeks. So the tests check both against the SAME lines.
 */

import { describe, expect, it } from 'vitest'

import { FISCAL_RECEIPT_TYPES } from '@/lib/fiscalCounter'
import { buildFiscalReceipt, type FiscalReceiptInput } from '@/lib/vsdc/fiscalReceipt'
import { describeEscposGaps, encodeQr, encodeRaster, renderReceiptAsEscpos } from '@/lib/vsdc/escposRenderer'
import { renderReceiptAsHtml } from '@/lib/vsdc/htmlRenderer'

const SALE: FiscalReceiptInput = {
  receiptType: FISCAL_RECEIPT_TYPES.NORMAL_SALE,
  tradeName: 'High 5ive',
  address: 'Kigali',
  tin: '999999991',
  mrc: 'AAACC123456',
  lines: [
    { name: 'Grilled Tilapia', unitPrice: 5000, qty: 2, taxCategory: 'B', chargedAmount: 10000 },
  ],
  taxBreakdown: [{ category: 'B', ratePercent: 18, grossAmount: 10000, taxAmount: 1525.42 }],
  totalAmount: 10000,
  totalTaxAmount: 1525.42,
  paymentLabel: 'Cash',
  cisReceiptNumber: '152',
  cisDate: '05/09/2026',
  cisTime: '20:15:00',
  vsdc: {
    sdcId: 'SDC001000001',
    date: '05/09/2026',
    time: '20:15:03',
    receiptNumberForType: 168,
    receiptNumberTotal: 258,
    internalData: 'TE68SLA234J5EAV3',
    receiptSignature: 'V249J39CFJ48HE2W',
  },
}

const lines = buildFiscalReceipt(SALE)
const escpos = renderReceiptAsEscpos(lines)
const html = renderReceiptAsHtml(lines)

/** Decodes the printable text out of the byte stream, for comparison. */
function textOf(payload: Uint8Array): string {
  return new TextDecoder().decode(payload).replace(/[\x00-\x08\x0b-\x1f]/g, '')
}

describe('the two renderers agree', () => {
  it('both carry the taxpayer header', () => {
    for (const output of [textOf(escpos), html]) {
      expect(output).toContain('High 5ive')
      expect(output).toContain('TIN: 999999991')
    }
  })

  it('both carry the SDC block and both receipt numbers', () => {
    for (const output of [textOf(escpos), html]) {
      expect(output).toContain('SDC ID: SDC001000001')
      expect(output).toContain('168/258')
    }
  })

  it('both carry the signature grouped in fours', () => {
    for (const output of [textOf(escpos), html]) {
      expect(output).toContain('V249-J39C-FJ48-HE2W')
    }
  })

  it('both carry the totals', () => {
    for (const output of [textOf(escpos), html]) {
      expect(output).toContain('10000.00')
      expect(output).toContain('1525.42')
    }
  })
})

describe('ESC/POS', () => {
  it('initialises and cuts', () => {
    expect(Array.from(escpos.slice(0, 2))).toEqual([0x1b, 0x40])
    expect(Array.from(escpos.slice(-3))).toEqual([0x1d, 0x56, 0x00])
  })

  it('emits a QR code for the verification payload', () => {
    // GS ( k with the store-and-print function.
    const stream = Array.from(escpos)
    const marker = [0x1d, 0x28, 0x6b]
    const found = stream.some((_, i) => marker.every((b, j) => stream[i + j] === b))

    expect(found).toBe(true)
  })

  it('builds the QR commands in the required order', () => {
    // Model, then size, then error correction, then store, then print. A
    // printer given the data before the model prints nothing at all — a blank
    // space where the QR should be, with no error.
    const qr = Array.from(encodeQr('TEST'))

    expect(qr.slice(0, 9)).toEqual([0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00])
    expect(qr.slice(9, 17)).toEqual([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 6])
    expect(qr.slice(-8)).toEqual([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30])
  })

  it('encodes a raster with the width in BYTES, not dots', () => {
    // A width given in dots shears the image diagonally rather than failing,
    // which is a miserable thing to debug from a photo of a receipt.
    const raster = Array.from(encodeRaster(new Uint8Array(16), 64, 2))

    expect(raster.slice(0, 8)).toEqual([0x1d, 0x76, 0x30, 0x00, 8, 0, 2, 0])
  })

  it('prints no logo at all when none is supplied', () => {
    // A placeholder drawn by us would look finished and is not.
    expect(describeEscposGaps(lines)).toEqual(
      expect.arrayContaining([expect.stringContaining('logo artwork not supplied')]),
    )
  })
})

describe('watermarks — where the two renderers must differ', () => {
  const copy = buildFiscalReceipt({ ...SALE, receiptType: FISCAL_RECEIPT_TYPES.COPY })

  it('HTML composites a real watermark behind the text (§11)', () => {
    const output = renderReceiptAsHtml(copy)

    expect(output).toContain('class="wm"')
    expect(output).toContain('COPY')
    expect(output).toContain('THIS IS NOT AN OFFICIAL RECEIPT')
  })

  it('thermal prints it as a banded heading and says so', () => {
    const output = textOf(renderReceiptAsEscpos(copy))

    expect(output).toContain('COPY')
    expect(output).toContain('THIS IS NOT AN OFFICIAL RECEIPT')
    // Reported as a known limitation rather than passed off as satisfied.
    expect(describeEscposGaps(copy)).toEqual(
      expect.arrayContaining([expect.stringContaining('cannot overlay')]),
    )
  })
})

describe('HTML', () => {
  it('falls back to printing the QR payload as text when no image is supplied', () => {
    // The verification data must reach the paper either way — a receipt
    // silently missing it is worse than an ugly one.
    // ddmmyyyy with no separators (§7.24.7), unlike the dd/mm/yyyy printed in
    // the SDC block above it — the same date twice, in two formats.
    expect(html).toContain('05092026#201503#SDC001000001#168#TE68SLA234J5EAV3#V249J39CFJ48HE2W')
  })

  it('uses a QR image when one is given', () => {
    const withImage = renderReceiptAsHtml(lines, { qrDataUri: 'data:image/png;base64,AAAA' })

    expect(withImage).toContain('<img class="qr"')
  })

  it('escapes text rather than letting it become markup', () => {
    const output = renderReceiptAsHtml(
      buildFiscalReceipt({ ...SALE, tradeName: '<script>alert(1)</script>' }),
    )

    expect(output).not.toContain('<script>alert(1)</script>')
    expect(output).toContain('&lt;script&gt;')
  })
})
