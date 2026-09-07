/**
 * Per-bracket tax comes from the bracket total, never from summing the rounded
 * lines (§13.1).
 *
 * This is the single arithmetic detail most likely to be checked by hand
 * against RRA's own printed sample, and the two methods differ by a franc:
 *
 *   per line, then summed : 768.81 + 45.76 = 814.57
 *   from the bracket total: 5,340 × 18/118 = 814.58   ← what RRA prints
 *
 * The receipt and the VSDC declaration must agree on it, because the signature
 * covers both.
 */

import { describe, it, expect } from 'vitest'
import { calculateRestaurantOrderTotals, summarizeTaxByCategory } from '@/lib/restaurantOrders'
import { buildVsdcSalesPayload } from '@/lib/vsdc/salesPayload'

const fiscal = { fiscalMode: true }

// The bill printed in clause 13.1: bread exempt, gouda discounted, gum.
const SAMPLE_BILL = [
  { dishPrice: 1000, qty: 1, taxCategory: 'A' },
  { dishPrice: 33600, qty: 0.2, taxCategory: 'B', discountPercent: 25 },
  { dishPrice: 60, qty: 5, taxCategory: 'B' },
]

describe("RRA's own sample bill", () => {
  const totals = calculateRestaurantOrderTotals(SAMPLE_BILL as never, fiscal)
  const brackets = summarizeTaxByCategory(totals.taxLines)

  it('totals 6,340.00', () => {
    expect(totals.totalAmount).toBe(6340)
  })

  it('puts 1,000.00 in the exempt bracket and no tax on it', () => {
    const a = brackets.find((row) => row.category === 'A')!
    expect(a.grossAmount).toBe(1000)
    expect(a.taxAmount).toBe(0)
  })

  it('puts 5,340.00 in the standard bracket', () => {
    expect(brackets.find((row) => row.category === 'B')!.grossAmount).toBe(5340)
  })

  it('takes 814.58 from that bracket — not the 814.57 the lines would sum to', () => {
    const b = brackets.find((row) => row.category === 'B')!
    expect(b.taxAmount).toBe(814.58)

    // The method that would be wrong, stated so the difference stays visible.
    const summedFromLines = Math.round(
      totals.taxLines
        .filter((line) => line.category === 'B')
        .reduce((sum, line) => sum + line.taxAmount, 0) * 100,
    ) / 100
    expect(summedFromLines).toBe(814.57)
    expect(b.taxAmount).not.toBe(summedFromLines)
  })

  it('keeps taxable and tax adding back to the bracket total', () => {
    for (const bracket of brackets) {
      expect(bracket.taxableAmount + bracket.taxAmount).toBeCloseTo(bracket.grossAmount, 2)
    }
  })

  it('declares the same 814.58 to the VSDC as it prints', () => {
    // The two must not be computed by different routes: the receipt signature
    // covers the printed figures and the declared ones together.
    const payload = buildVsdcSalesPayload({
      tin: '149047989',
      bhfId: '00',
      invoiceNumber: 1,
      salesDate: '20260908',
      confirmedAt: '20260908103000',
      paymentMethod: 'Cash',
      receiptType: 'S',
      registrantId: '1',
      registrantName: 'Magnify',
      // Same bill, expressed the way the payload builder names its fields.
      lines: SAMPLE_BILL.map((line, index) => ({
        itemCode: `MG000000${index + 1}`,
        name: `Item ${index + 1}`,
        unitPrice: line.dishPrice,
        qty: line.qty,
        discountPercent: line.discountPercent ?? 0,
        taxCategory: line.taxCategory,
      })),
    } as never)

    expect(payload.taxAmtB).toBe(814.58)
    expect(payload.taxAmtB).toBe(brackets.find((row) => row.category === 'B')!.taxAmount)
  })
})
