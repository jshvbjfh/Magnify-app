// Building the RRA VSDC sales payload.
//
// Turns one settled Magnify order into the body of POST /trnsSales/saveSales,
// per RRA's VSDC API specification v1.0.4 (2022).
//
// PURE. No database, no network, no clock — every input is passed in. That is
// deliberate: this is the piece where a wrong number becomes a wrong tax
// declaration, so it has to be testable against RRA's own worked examples
// without standing anything up.
//
// ── The one thing to get right ──────────────────────────────────────────────
//
// `taxblAmt` is the VAT-INCLUSIVE amount, not the net. RRA's own sample:
//
//     "prc":200000, "splyAmt":200000, "taxblAmt":200000, "taxAmt":30508
//
// 200,000 × 18/118 = 30,508. So the taxable amount carries the tax inside it,
// and the tax is extracted. Sending the net (169,492) would under-declare every
// line. This matches how Magnify prices already work — menu prices include VAT.

import {
  normalizeTaxCategory,
  rateForTaxCategory,
  round2,
  splitTaxInclusive,
  type RraTaxCategory,
} from '@/lib/restaurantVat'

/** §4.9 Sales Receipt Type. */
export const VSDC_RECEIPT_TYPE = { SALE: 'S', REFUND: 'R' } as const

/** §4.11 Transaction Progress. */
export const VSDC_TRANSACTION_STATUS = {
  WAIT_FOR_APPROVAL: '01',
  APPROVED: '02',
  CANCEL_REQUESTED: '03',
  CANCELED: '04',
  REFUNDED: '05',
  TRANSFERRED: '06',
} as const

/** §4.10 Payment Method. */
export const VSDC_PAYMENT_METHOD = {
  CASH: '01',
  CREDIT: '02',
  CASH_CREDIT: '03',
  BANK_CHECK: '04',
  CARD: '05',
  MOBILE_MONEY: '06',
  OTHER: '07',
} as const

export type VsdcPaymentMethod = (typeof VSDC_PAYMENT_METHOD)[keyof typeof VSDC_PAYMENT_METHOD]

/**
 * Magnify's tender strings → RRA payment codes.
 *
 * Matched loosely and case-insensitively because the tender is free text with
 * no enum behind it, and the apps have already drifted: the till writes 'MoMo'
 * where the manager screen writes 'Mobile Money', and comps have about a dozen
 * spellings. Substring matching is what the accounting module already does for
 * the same reason.
 *
 * Anything unrecognised becomes OTHER rather than throwing. A sale that cannot
 * be classified must still be declared — refusing to build the payload would
 * block the till mid-service over a tender label, which is the one failure this
 * must never cause.
 */
export function toVsdcPaymentMethod(paymentMethod: string | null | undefined): VsdcPaymentMethod {
  const raw = String(paymentMethod ?? '').trim().toLowerCase()

  if (!raw) return VSDC_PAYMENT_METHOD.OTHER
  if (raw.includes('momo') || raw.includes('mobile')) return VSDC_PAYMENT_METHOD.MOBILE_MONEY
  if (raw.includes('card')) return VSDC_PAYMENT_METHOD.CARD
  if (raw.includes('cheque') || raw.includes('check')) return VSDC_PAYMENT_METHOD.BANK_CHECK
  // Before 'cash': "cash/credit" must not match as plain cash.
  if (raw.includes('cash') && raw.includes('credit')) return VSDC_PAYMENT_METHOD.CASH_CREDIT
  if (raw.includes('cash')) return VSDC_PAYMENT_METHOD.CASH
  // A/R tabs settle as 'Credit'. Bank transfer has no code of its own — 04 is
  // specifically a cheque — so it falls through to OTHER.
  if (raw.includes('credit')) return VSDC_PAYMENT_METHOD.CREDIT

  return VSDC_PAYMENT_METHOD.OTHER
}

/** Trims to the field's declared maximum so RRA cannot reject the whole sale
 *  over a long dish name. */
function cap(value: string | null | undefined, max: number): string {
  return String(value ?? '').trim().slice(0, max)
}

export type VsdcSalesLineInput = {
  /** Dish.itemCode — what RRA knows this item as. */
  itemCode: string
  /** RRA's classification code for what the item IS. */
  classificationCode?: string | null
  name: string
  barcode?: string | null
  packagingUnitCode?: string | null
  quantityUnitCode?: string | null
  /** Menu price per unit, VAT-inclusive. */
  unitPrice: number
  qty: number
  /** 0–100. Null and out-of-range both mean no discount. */
  discountPercent?: number | null
  taxCategory?: string | null
}

export type VsdcSalesInput = {
  tin: string
  /** Branch id as RRA issued it, two characters, e.g. "00". */
  bhfId: string
  /** The gap-free invoice number claimed for this sale. */
  invoiceNumber: number
  /** The invoice being refunded. 0 for an ordinary sale. */
  originalInvoiceNumber?: number
  receiptType: (typeof VSDC_RECEIPT_TYPE)[keyof typeof VSDC_RECEIPT_TYPE]
  paymentMethod?: string | null
  /** Buyer's TIN for a business customer. */
  customerTin?: string | null
  customerName?: string | null
  customerMobile?: string | null
  /** yyyyMMddhhmmss */
  confirmedAt: string
  /** yyyyMMdd */
  salesDate: string
  registrantId: string
  registrantName: string
  tradeName?: string | null
  address?: string | null
  topMessage?: string | null
  bottomMessage?: string | null
  /** Report number on the receipt. */
  reportNumber?: number
  remark?: string | null
  lines: VsdcSalesLineInput[]
}

const TAX_CATEGORIES: RraTaxCategory[] = ['A', 'B', 'C', 'D']

/**
 * Builds one line of the sales payload.
 *
 * `splyAmt` is the supply amount BEFORE discount (unit price × quantity);
 * `taxblAmt` and `totAmt` are what the guest is actually charged, after it.
 * RRA's sample shows all three equal only because that sample has no discount.
 */
function buildLine(line: VsdcSalesLineInput, itemSeq: number) {
  const category = normalizeTaxCategory(line.taxCategory)
  const qty = Number(line.qty)
  const unitPrice = round2(Number(line.unitPrice))

  const supplyAmount = round2(unitPrice * qty)

  const rawDiscount = Number(line.discountPercent)
  const discountRate = Number.isFinite(rawDiscount) && rawDiscount > 0 && rawDiscount <= 100 ? rawDiscount : 0
  const chargedAmount = round2(supplyAmount * (1 - discountRate / 100))
  // Taken as the remainder so discount + charged always equals the supply
  // amount exactly, whatever the rounding.
  const discountAmount = round2(supplyAmount - chargedAmount)

  const { taxAmount } = splitTaxInclusive(chargedAmount, category)

  return {
    itemSeq,
    itemCd: cap(line.itemCode, 20),
    itemClsCd: cap(line.classificationCode, 10) || null,
    itemNm: cap(line.name, 200),
    bcd: cap(line.barcode, 20) || null,
    pkgUnitCd: cap(line.packagingUnitCode, 5) || 'NT',
    pkg: 1,
    qtyUnitCd: cap(line.quantityUnitCode, 5) || 'U',
    qty,
    prc: unitPrice,
    splyAmt: supplyAmount,
    dcRt: round2(discountRate),
    dcAmt: discountAmount,
    isrccCd: null,
    isrccNm: null,
    isrcRt: null,
    isrcAmt: null,
    taxTyCd: category,
    // VAT-inclusive. See the note at the top of this file.
    taxblAmt: chargedAmount,
    taxAmt: taxAmount,
    totAmt: chargedAmount,
  }
}

/**
 * Builds the complete POST /trnsSales/saveSales body.
 *
 * The per-bracket header totals are summed from the lines they describe, never
 * computed independently. RRA's own JSON sample is internally inconsistent here
 * — it declares taxAmtB as 94576 while its two B-rated lines sum to 38135,
 * which also equals its own totTaxAmt — so the sample cannot be followed
 * literally. Summing from the lines is the only reading under which the
 * document agrees with itself, and it is what the receipt prints.
 */
export function buildVsdcSalesPayload(input: VsdcSalesInput) {
  const itemList = input.lines.map((line, index) => buildLine(line, index + 1))

  const bracketTotals = Object.fromEntries(
    TAX_CATEGORIES.map((category) => {
      const lines = itemList.filter((line) => line.taxTyCd === category)
      const taxableAmount = round2(lines.reduce((sum, line) => sum + line.taxblAmt, 0))

      return [
        category,
        {
          taxableAmount,
          // Computed from the BRACKET total, not by summing the rounded lines.
          //
          // Those two disagree by a franc often enough to matter, and RRA's own
          // printed receipt takes the bracket. Their sample bill has a 5,040
          // line and a 300 line, both standard-rated:
          //
          //   per line, then summed : 768.81 + 45.76        = 814.57
          //   from the bracket total: 5,340 × 18/118        = 814.58   ← printed
          //
          // So the per-line taxAmt figures the API also carries need not sum to
          // this exactly, and deliberately do not. Making them agree by forcing
          // one to match the other would put a number on the receipt that RRA's
          // own arithmetic does not produce.
          taxAmount: splitTaxInclusive(taxableAmount, category).taxAmount,
          rate: round2(rateForTaxCategory(category) * 100),
        },
      ]
    }),
  ) as Record<RraTaxCategory, { taxableAmount: number; taxAmount: number; rate: number }>

  const totalTaxableAmount = round2(itemList.reduce((sum, line) => sum + line.taxblAmt, 0))
  // Sum of the four brackets, so the total agrees with the per-bracket figures
  // printed directly above it on the receipt.
  const totalTaxAmount = round2(
    TAX_CATEGORIES.reduce((sum, category) => sum + bracketTotals[category].taxAmount, 0),
  )
  const totalAmount = round2(itemList.reduce((sum, line) => sum + line.totAmt, 0))

  return {
    tin: cap(input.tin, 9),
    bhfId: cap(input.bhfId, 2),
    invcNo: input.invoiceNumber,
    orgInvcNo: input.originalInvoiceNumber ?? 0,
    custTin: cap(input.customerTin, 9) || null,
    custNm: cap(input.customerName, 60) || null,
    // §4.8 — "Send only 'N' type".
    salesTyCd: 'N',
    rcptTyCd: input.receiptType,
    pmtTyCd: toVsdcPaymentMethod(input.paymentMethod),
    salesSttsCd: VSDC_TRANSACTION_STATUS.APPROVED,
    cfmDt: input.confirmedAt,
    salesDt: input.salesDate,
    stockRlsDt: input.confirmedAt,
    cnclReqDt: null,
    cnclDt: null,
    rfdDt: input.receiptType === VSDC_RECEIPT_TYPE.REFUND ? input.confirmedAt : null,
    rfdRsnCd: null,
    totItemCnt: itemList.length,

    taxblAmtA: bracketTotals.A.taxableAmount,
    taxblAmtB: bracketTotals.B.taxableAmount,
    taxblAmtC: bracketTotals.C.taxableAmount,
    taxblAmtD: bracketTotals.D.taxableAmount,
    taxRtA: bracketTotals.A.rate,
    taxRtB: bracketTotals.B.rate,
    taxRtC: bracketTotals.C.rate,
    taxRtD: bracketTotals.D.rate,
    taxAmtA: bracketTotals.A.taxAmount,
    taxAmtB: bracketTotals.B.taxAmount,
    taxAmtC: bracketTotals.C.taxAmount,
    taxAmtD: bracketTotals.D.taxAmount,

    totTaxblAmt: totalTaxableAmount,
    totTaxAmt: totalTaxAmount,
    totAmt: totalAmount,

    prchrAcptcYn: 'N',
    remark: cap(input.remark, 400) || null,
    regrId: cap(input.registrantId, 20),
    regrNm: cap(input.registrantName, 60),
    modrId: cap(input.registrantId, 20),
    modrNm: cap(input.registrantName, 60),

    receipt: {
      custTin: cap(input.customerTin, 9) || null,
      custMblNo: cap(input.customerMobile, 20) || null,
      rptNo: input.reportNumber ?? 1,
      trdeNm: cap(input.tradeName, 20),
      adrs: cap(input.address, 200),
      topMsg: cap(input.topMessage, 20),
      btmMsg: cap(input.bottomMessage, 20),
      prchrAcptcYn: 'N',
    },

    itemList,
  }
}
