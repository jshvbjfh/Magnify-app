// The Z and X daily reports.
//
// §7.6 defines both: a Z report summarises a full day of operations, 00:00:00
// to 23:59:59, and closes it. An X report summarises everything since the last
// Z — NOT since the last X, which is the mistake worth naming, because taking X
// twice in a service would otherwise show the second one as almost empty.
//
// §18.1 lists twenty things the report must contain. Every one of them is a
// numbered comment below, so a reviewer can walk the clause list against this
// file and a future edit cannot quietly drop one.
//
// PURE, like the rest of lib/vsdc: the caller supplies the receipts and the
// figures the app knows outside them (opening float, incomplete sales). This
// computes and lays out; it reads nothing and prints nothing.

import { RRA_TAX_CATEGORIES, round2, type RraTaxCategory } from '@/lib/restaurantVat'
import { FISCAL_RECEIPT_TYPES, type FiscalReceiptType } from '@/lib/fiscalCounter'
import { VSDC_PAYMENT_METHOD } from '@/lib/vsdc/salesPayload'
import { renderReceiptAsText, type ReceiptLine } from '@/lib/vsdc/fiscalReceipt'

export type DailyReportKind = 'X' | 'Z'

const TAX_CATEGORIES: RraTaxCategory[] = ['A', 'B', 'C', 'D']

/** How each payment code prints on the report (§18.1.17). */
const PAYMENT_LABELS: Record<string, string> = {
  [VSDC_PAYMENT_METHOD.CASH]: 'CASH',
  [VSDC_PAYMENT_METHOD.CREDIT]: 'CREDIT',
  [VSDC_PAYMENT_METHOD.CASH_CREDIT]: 'CASH/CREDIT',
  [VSDC_PAYMENT_METHOD.BANK_CHECK]: 'BANK CHECK',
  [VSDC_PAYMENT_METHOD.CARD]: 'CARD',
  [VSDC_PAYMENT_METHOD.MOBILE_MONEY]: 'MOBILE MONEY',
  [VSDC_PAYMENT_METHOD.OTHER]: 'OTHER',
}

/** One receipt as the report needs to see it. Mirrors the FiscalReceipt row. */
export type ReportReceipt = {
  receiptType: FiscalReceiptType
  /** Tax-inclusive total. Refunds are stored positive and negated here. */
  totalAmount: number
  taxableByCategory?: Partial<Record<RraTaxCategory, number>>
  taxByCategory?: Partial<Record<RraTaxCategory, number>>
  itemCount?: number
  discountTotal?: number
  paymentTypeCode?: string | null
}

export type DailyReportInput = {
  kind: DailyReportKind
  tradeName: string
  tin: string
  mrc: string
  /** §18.1.4 — the CIS's own designation, printed beside the MRC. */
  cisDesignation: string
  /** §18.1.2 — when the report was taken. */
  date: string
  time: string
  /** The period covered, in words: a date for Z, "since last Z" for X. */
  periodLabel: string
  /** §18.1.12 */
  openingDeposit?: number
  /** §18.1.20 — bills started and abandoned without being settled. */
  incompleteSalesCount?: number
  /**
   * §18.1.19 — anything else that reduced the day's takings and is not a
   * discount on a line: a comped bill, a write-off. Named individually because
   * "other registrations that have reduced the day's sales" is exactly the line
   * an auditor asks about.
   */
  otherReductions?: Array<{ label: string; amount: number }>
  receipts: ReportReceipt[]
}

function emptyByCategory(): Record<RraTaxCategory, number> {
  return { A: 0, B: 0, C: 0, D: 0 }
}

function sumInto(target: Record<RraTaxCategory, number>, source?: Partial<Record<RraTaxCategory, number>>) {
  if (!source) return
  for (const category of TAX_CATEGORIES) {
    target[category] = round2(target[category] + (source[category] ?? 0))
  }
}

/** The computed report, before it is laid out. Useful on screen as well as on paper. */
export function summarizeDailyReport(input: DailyReportInput) {
  const of = (type: FiscalReceiptType) => input.receipts.filter((r) => r.receiptType === type)

  const sales = of(FISCAL_RECEIPT_TYPES.NORMAL_SALE)
  const refunds = of(FISCAL_RECEIPT_TYPES.REFUND)
  const copies = of(FISCAL_RECEIPT_TYPES.COPY)
  const training = of(FISCAL_RECEIPT_TYPES.TRAINING)
  const proforma = of(FISCAL_RECEIPT_TYPES.PROFORMA)

  const total = (rows: ReportReceipt[]) => round2(rows.reduce((sum, r) => sum + r.totalAmount, 0))

  // §18.1.10 and §18.1.11 — taxable and tax per rate, kept apart for sales and
  // refunds rather than netted. A day with equal sales and refunds must not
  // report as a day with no trade.
  const taxableSales = emptyByCategory()
  const taxSales = emptyByCategory()
  for (const r of sales) {
    sumInto(taxableSales, r.taxableByCategory)
    sumInto(taxSales, r.taxByCategory)
  }

  const taxableRefunds = emptyByCategory()
  const taxRefunds = emptyByCategory()
  for (const r of refunds) {
    sumInto(taxableRefunds, r.taxableByCategory)
    sumInto(taxRefunds, r.taxByCategory)
  }

  // §18.1.17 — takings by tender, sales and refunds separately.
  const byPayment = new Map<string, { sales: number; refunds: number }>()
  for (const r of [...sales, ...refunds]) {
    const code = r.paymentTypeCode ?? VSDC_PAYMENT_METHOD.OTHER
    const row = byPayment.get(code) ?? { sales: 0, refunds: 0 }
    if (r.receiptType === FISCAL_RECEIPT_TYPES.REFUND) row.refunds = round2(row.refunds + r.totalAmount)
    else row.sales = round2(row.sales + r.totalAmount)
    byPayment.set(code, row)
  }

  const otherReductions = input.otherReductions ?? []

  return {
    kind: input.kind,
    salesCount: sales.length,                                    // §18.1.7
    salesTotal: total(sales),                                    // §18.1.5
    refundCount: refunds.length,                                 // §18.1.9
    refundTotal: total(refunds),                                 // §18.1.8
    taxableSales, taxSales, taxableRefunds, taxRefunds,          // §18.1.10-.11
    openingDeposit: round2(input.openingDeposit ?? 0),           // §18.1.12
    itemsSold: sales.reduce((n, r) => n + (r.itemCount ?? 0), 0),// §18.1.13
    copies: { count: copies.length, amount: total(copies) },     // §18.1.14
    training: { count: training.length, amount: total(training) },// §18.1.15
    proforma: { count: proforma.length, amount: total(proforma) },// §18.1.16
    byPayment,                                                   // §18.1.17
    discountTotal: round2(                                       // §18.1.18
      [...sales, ...refunds].reduce((sum, r) => sum + (r.discountTotal ?? 0), 0),
    ),
    otherReductions,                                             // §18.1.19
    otherReductionsTotal: round2(otherReductions.reduce((sum, r) => sum + r.amount, 0)),
    incompleteSalesCount: input.incompleteSalesCount ?? 0,       // §18.1.20
    // What the till should hold if nothing has gone astray.
    netTotal: round2(total(sales) - total(refunds)),
  }
}

function money(value: number): string {
  return round2(value).toFixed(2)
}

/**
 * Lays the report out as printable lines.
 *
 * Reuses the receipt's line format so both go through the same two printers.
 * The report is not a receipt and carries no SDC block or signature — it
 * summarises signed receipts, it is not itself one.
 */
export function buildDailyReport(input: DailyReportInput): ReceiptLine[] {
  const s = summarizeDailyReport(input)
  const out: ReceiptLine[] = []

  // §18.1.1 — trade name and TIN.
  out.push({ kind: 'text', text: input.tradeName, align: 'center', bold: true })
  out.push({ kind: 'text', text: `TIN: ${input.tin}`, align: 'center' })

  // §18.1.3 — it must say which report this is. Named in full and doubled in
  // size: an X mistaken for a Z is a day closed by accident.
  out.push({ kind: 'text', text: `${input.kind} DAILY REPORT`, align: 'center', bold: true, scale: 2 })
  out.push({ kind: 'text', text: input.periodLabel, align: 'center' })
  out.push({ kind: 'rule' })

  // §18.1.2 and §18.1.4.
  out.push({ kind: 'text', text: `DATE: ${input.date} TIME: ${input.time}` })
  out.push({ kind: 'text', text: `CIS: ${input.cisDesignation}` })
  out.push({ kind: 'text', text: `MRC: ${input.mrc}` })
  out.push({ kind: 'rule' })

  // §18.1.12 — opening float, before any trade.
  out.push({ kind: 'pair', left: 'OPENING DEPOSIT', right: money(s.openingDeposit) })
  out.push({ kind: 'rule' })

  // §18.1.5, .7 — sales.
  out.push({ kind: 'pair', left: 'SALES (NS)', right: String(s.salesCount) })
  out.push({ kind: 'pair', left: 'TOTAL SALES', right: money(s.salesTotal), bold: true })
  // §18.1.13
  out.push({ kind: 'pair', left: 'ITEMS SOLD', right: String(s.itemsSold) })
  out.push({ kind: 'rule' })

  // §18.1.8, .9 — refunds. Shown negative, as they print on the receipt.
  out.push({ kind: 'pair', left: 'REFUNDS (NR)', right: String(s.refundCount) })
  out.push({ kind: 'pair', left: 'TOTAL REFUNDS', right: money(-s.refundTotal), bold: true })
  out.push({ kind: 'rule' })

  // §18.1.10, .11 — per rate, sales and refunds apart.
  for (const category of TAX_CATEGORIES) {
    const rate = RRA_TAX_CATEGORIES[category].rate * 100
    const label = rate > 0 ? `${category}-${rate.toFixed(2)}%` : `${category}-EX`

    // A bracket nothing touched all day prints nothing, keeping the report to
    // what actually happened.
    if (!s.taxableSales[category] && !s.taxableRefunds[category]) continue

    out.push({ kind: 'pair', left: `TAXABLE ${label} (NS)`, right: money(s.taxableSales[category]) })
    out.push({ kind: 'pair', left: `TAX ${label} (NS)`, right: money(s.taxSales[category]) })
    if (s.taxableRefunds[category] || s.taxRefunds[category]) {
      out.push({ kind: 'pair', left: `TAXABLE ${label} (NR)`, right: money(-s.taxableRefunds[category]) })
      out.push({ kind: 'pair', left: `TAX ${label} (NR)`, right: money(-s.taxRefunds[category]) })
    }
  }
  out.push({ kind: 'rule' })

  // §18.1.17 — by tender.
  for (const [code, row] of [...s.byPayment.entries()].sort()) {
    const label = PAYMENT_LABELS[code] ?? 'OTHER'
    if (row.sales) out.push({ kind: 'pair', left: `${label} (NS)`, right: money(row.sales) })
    if (row.refunds) out.push({ kind: 'pair', left: `${label} (NR)`, right: money(-row.refunds) })
  }
  out.push({ kind: 'rule' })

  // §18.1.14, .15, .16 — the non-sale receipt types, counted and totalled.
  out.push({ kind: 'pair', left: 'COPIES (CS)', right: `${s.copies.count} / ${money(s.copies.amount)}` })
  out.push({ kind: 'pair', left: 'TRAINING (TS)', right: `${s.training.count} / ${money(s.training.amount)}` })
  out.push({ kind: 'pair', left: 'PROFORMA (PS)', right: `${s.proforma.count} / ${money(s.proforma.amount)}` })
  out.push({ kind: 'rule' })

  // §18.1.18 — every discount given.
  out.push({ kind: 'pair', left: 'DISCOUNTS', right: money(-s.discountTotal) })

  // §18.1.19 — anything else that reduced takings, named one by one.
  for (const reduction of s.otherReductions) {
    out.push({ kind: 'pair', left: reduction.label.toUpperCase(), right: money(-reduction.amount) })
  }
  if (s.otherReductions.length > 1) {
    out.push({ kind: 'pair', left: 'OTHER REDUCTIONS', right: money(-s.otherReductionsTotal) })
  }

  // §18.1.20
  out.push({ kind: 'pair', left: 'INCOMPLETE SALES', right: String(s.incompleteSalesCount) })
  out.push({ kind: 'rule' })

  out.push({ kind: 'pair', left: 'NET TOTAL', right: money(s.netTotal), bold: true })

  return out
}

/** The report as fixed-width text, for tests and the audit interface (§7.26). */
export function renderDailyReportAsText(input: DailyReportInput, width = 48): string {
  return renderReceiptAsText(buildDailyReport(input), width)
}
