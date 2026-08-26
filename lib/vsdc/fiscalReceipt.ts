// The fiscal receipt.
//
// Builds the RRA-compliant receipt as an ordered list of lines, from a settled
// order plus the VSDC's response. PURE — no printer, no database, no clock.
//
// ── One definition, two printers ────────────────────────────────────────────
//
// Magnify prints through two entirely separate renderers: raw ESC/POS bytes for
// thermal printers, and HTML for system printers. They have drifted before —
// discounts appeared on screen and not on thermal paper, so guests were handed
// bills at full price for weeks. A fiscal receipt cannot afford that: a receipt
// missing its signature is not a receipt.
//
// So the layout is decided ONCE, here, as structured lines. Each renderer's job
// is reduced to turning a line into bytes or into markup. Neither decides what
// goes on the paper.
//
// Clause references are to RRA's Technical Specification of CIS for VSDC v1.0.

import { round2, type RraTaxCategory } from '@/lib/restaurantVat'
import { FISCAL_RECEIPT_TYPES, type FiscalReceiptType } from '@/lib/fiscalCounter'

/** How a line is set on the paper. Renderers map these to their own commands. */
export type ReceiptLineStyle = {
  align?: 'left' | 'center'
  bold?: boolean
  /** 1 = normal, 2 = double height/width. §11 needs the disclaimer at least
   *  twice the size of the amount text. */
  scale?: 1 | 2
}

export type ReceiptLine =
  | ({ kind: 'text'; text: string } & ReceiptLineStyle)
  /** Left/right pair, e.g. "TOTAL" ......... "6340.00". */
  | ({ kind: 'pair'; left: string; right: string } & ReceiptLineStyle)
  | { kind: 'rule' }
  | { kind: 'blank' }
  | { kind: 'logo' }
  | { kind: 'qr'; payload: string }
  /** The COPY / TRAINING / PROFORMA watermark behind the body (§11). */
  | { kind: 'watermark'; text: string }

export type FiscalReceiptLineInput = {
  name: string
  unitPrice: number
  qty: number
  discountPercent?: number | null
  taxCategory: RraTaxCategory
  /** The line's charge after discount, VAT-inclusive. */
  chargedAmount: number
  notes?: string | null
}

export type VsdcResponse = {
  /** e.g. "SDC001000001" */
  sdcId: string
  /** VSDC's own date, dd/mm/yyyy. */
  date: string
  /** VSDC's own time, hh:mm:ss. */
  time: string
  /** Counter for this receipt type. */
  receiptNumberForType: number
  /** Counter across all receipt types. */
  receiptNumberTotal: number
  internalData: string
  receiptSignature: string
}

export type FiscalReceiptInput = {
  receiptType: FiscalReceiptType
  tradeName: string
  address?: string | null
  tin: string
  mrc: string
  topMessage?: string | null
  bottomMessage?: string | null
  customerTin?: string | null
  /** The receipt this one reverses. Required for a refund (§7.17). */
  refundedReceiptNumber?: string | null
  lines: FiscalReceiptLineInput[]
  /** Per-bracket totals, in bracket order. */
  taxBreakdown: Array<{ category: RraTaxCategory; ratePercent: number; grossAmount: number; taxAmount: number }>
  totalAmount: number
  totalTaxAmount: number
  paymentLabel: string
  /** Magnify's own order number and timestamps (§13.1 — the CIS block). */
  cisReceiptNumber: string
  cisDate: string
  cisTime: string
  /** Absent for training and proforma, which are never signed (§6.3.6). */
  vsdc?: VsdcResponse | null
}

/**
 * Groups a string in fours, dash-separated (§7.24.5–.6).
 *
 * `TE68SLA234J5` becomes `TE68-SLA2-34J5`. The spec says "separate by dash
 * after every 4th character", so a trailing partial group keeps whatever it
 * has rather than being padded.
 */
export function groupInFours(value: string | null | undefined): string {
  const clean = String(value ?? '').replace(/[^A-Za-z0-9]/g, '')
  if (!clean) return ''

  return (clean.match(/.{1,4}/g) ?? []).join('-')
}

/**
 * The QR payload, exactly as §7.24.7 defines it:
 *
 *   invoice_date(ddmmyyyy)#time(hhmmss)#sdc number#sdc_receipt_number
 *   #internal_data#receipt_signature
 *
 * Note the date here is ddmmyyyy with no separators, while the SDC block prints
 * dd/mm/yyyy — the same date in two formats on one receipt. Separators are
 * stripped rather than assumed absent so either input form works.
 */
export function buildQrPayload(vsdc: VsdcResponse): string {
  const date = vsdc.date.replace(/\D/g, '')
  const time = vsdc.time.replace(/\D/g, '')

  return [
    date,
    time,
    vsdc.sdcId,
    String(vsdc.receiptNumberForType),
    vsdc.internalData.replace(/-/g, ''),
    vsdc.receiptSignature.replace(/-/g, ''),
  ].join('#')
}

/** Receipt types that are not real sales and must be marked as such (§11). */
const UNOFFICIAL_LABELS: Partial<Record<FiscalReceiptType, string>> = {
  [FISCAL_RECEIPT_TYPES.COPY]: 'COPY',
  [FISCAL_RECEIPT_TYPES.TRAINING]: 'TRAINING',
  [FISCAL_RECEIPT_TYPES.PROFORMA]: 'PROFORMA',
}

function money(value: number): string {
  // Two decimals, dot separator (§7.5). Negative signs are carried through for
  // refunds rather than added by the caller.
  return round2(value).toFixed(2)
}

/**
 * Builds the receipt.
 *
 * A refund (§13.2) prints every figure NEGATIVE — lines, totals, tax and
 * tender alike — and names the receipt it reverses. That sign is applied here
 * rather than expected from the caller, so a refund cannot be built that looks
 * like a sale.
 */
export function buildFiscalReceipt(input: FiscalReceiptInput): ReceiptLine[] {
  const isRefund = input.receiptType === FISCAL_RECEIPT_TYPES.REFUND
  const sign = isRefund ? -1 : 1
  const unofficialLabel = UNOFFICIAL_LABELS[input.receiptType]

  const out: ReceiptLine[] = []

  // §7.29 — the RRA logo prints on every receipt, whatever its type.
  out.push({ kind: 'logo' })

  // ── Taxpayer header ──────────────────────────────────────────────────────
  out.push({ kind: 'text', text: input.tradeName, align: 'center', bold: true })
  if (input.address?.trim()) out.push({ kind: 'text', text: input.address.trim(), align: 'center' })
  out.push({ kind: 'text', text: `TIN: ${input.tin}`, align: 'center' })
  out.push({ kind: 'rule' })

  // §11 — the designation sits below the header and above the items, AND as a
  // watermark. Both, not either.
  if (unofficialLabel) {
    out.push({ kind: 'watermark', text: unofficialLabel })
    out.push({ kind: 'text', text: unofficialLabel, align: 'center', bold: true, scale: 2 })
    out.push({ kind: 'rule' })
  }

  if (isRefund) {
    out.push({ kind: 'text', text: 'REFUND', align: 'center', bold: true })
    out.push({ kind: 'text', text: `REF. NORMAL RECEIPT#: ${input.refundedReceiptNumber ?? ''}`, align: 'center' })
    out.push({ kind: 'rule' })
    out.push({ kind: 'text', text: 'REFUND IS APPROVED ONLY FOR', align: 'center' })
    out.push({ kind: 'text', text: 'ORIGINAL SALES RECEIPT', align: 'center' })
  }

  if (input.topMessage?.trim()) out.push({ kind: 'text', text: input.topMessage.trim(), align: 'center' })
  if (input.customerTin?.trim()) out.push({ kind: 'text', text: `Client ID: ${input.customerTin.trim()}` })
  out.push({ kind: 'rule' })

  // ── Items ────────────────────────────────────────────────────────────────
  // Two lines each, as the spec's sample sets them: the description on its own
  // line, then price × quantity, the amount, and the tax letter.
  for (const line of input.lines) {
    out.push({ kind: 'text', text: line.name })

    const gross = round2(line.unitPrice * line.qty)
    out.push({
      kind: 'pair',
      left: `${money(line.unitPrice)}x ${line.qty}`,
      right: `${money(sign * gross)}${line.taxCategory}`,
    })

    if (line.discountPercent && line.discountPercent > 0) {
      out.push({
        kind: 'pair',
        left: `discount -${line.discountPercent}%`,
        right: money(sign * line.chargedAmount),
      })
    }

    if (line.notes?.trim()) out.push({ kind: 'text', text: `  > ${line.notes.trim()}` })
  }

  out.push({ kind: 'rule' })

  // ── Totals ───────────────────────────────────────────────────────────────
  out.push({ kind: 'pair', left: 'TOTAL', right: money(sign * input.totalAmount), bold: true })

  // §7.22 — every rate programmed above zero prints on every receipt, used or
  // not. §7.23 — a zero rate prints only when an item actually used it. Both
  // rules are the caller's to satisfy by what it puts in taxBreakdown; this
  // renders whatever it is given, in bracket order.
  for (const bracket of input.taxBreakdown) {
    const label = bracket.ratePercent > 0
      ? `TOTAL ${bracket.category}-${bracket.ratePercent.toFixed(2)}%`
      : `TOTAL ${bracket.category}-EX`
    out.push({ kind: 'pair', left: label, right: money(sign * bracket.grossAmount) })
  }

  for (const bracket of input.taxBreakdown) {
    if (bracket.ratePercent <= 0) continue
    out.push({ kind: 'pair', left: `TOTAL TAX ${bracket.category}`, right: money(sign * bracket.taxAmount) })
  }

  out.push({ kind: 'pair', left: 'TOTAL TAX', right: money(sign * input.totalTaxAmount) })
  out.push({ kind: 'rule' })

  // ── Tender and item count ────────────────────────────────────────────────
  out.push({ kind: 'pair', left: input.paymentLabel.toUpperCase(), right: money(sign * input.totalAmount) })
  // §7.27 — the number of items shown on the receipt, excluding voids. Voided
  // lines never reach this function, so the count is simply what was printed.
  out.push({ kind: 'pair', left: 'ITEMS NUMBER', right: String(input.lines.length) })
  out.push({ kind: 'rule' })

  // ── SDC information (§7.24) ──────────────────────────────────────────────
  // Absent on training and proforma tickets, which are never signed (§6.3.6).
  if (input.vsdc) {
    out.push({ kind: 'text', text: 'SDC INFORMATION', align: 'center' })
    out.push({ kind: 'text', text: `Date: ${input.vsdc.date} Time: ${input.vsdc.time}` })
    out.push({ kind: 'text', text: `SDC ID: ${input.vsdc.sdcId}` })
    out.push({
      kind: 'text',
      text: `RECEIPT NUMBER: ${input.vsdc.receiptNumberForType}/${input.vsdc.receiptNumberTotal}  ${input.receiptType}`,
    })
    out.push({ kind: 'text', text: 'Internal Data:' })
    out.push({ kind: 'text', text: groupInFours(input.vsdc.internalData) })
    out.push({ kind: 'text', text: 'Receipt Signature:' })
    out.push({ kind: 'text', text: groupInFours(input.vsdc.receiptSignature) })
    out.push({ kind: 'qr', payload: buildQrPayload(input.vsdc) })
    out.push({ kind: 'rule' })
  }

  // ── CIS block (§13.1) — Magnify's own number and clock, not the VSDC's ────
  out.push({ kind: 'text', text: `RECEIPT NUMBER: ${input.cisReceiptNumber}` })
  out.push({ kind: 'text', text: `DATE: ${input.cisDate} TIME: ${input.cisTime}` })
  out.push({ kind: 'text', text: `MRC: ${input.mrc}` })
  out.push({ kind: 'rule' })

  // §11 — below the amount totals, at least twice the size of the amount text.
  if (unofficialLabel) {
    out.push({ kind: 'text', text: 'THIS IS NOT AN OFFICIAL RECEIPT', align: 'center', bold: true, scale: 2 })
    out.push({ kind: 'rule' })
  }

  if (input.bottomMessage?.trim()) {
    for (const message of input.bottomMessage.split('\n')) {
      out.push({ kind: 'text', text: message.trim(), align: 'center' })
    }
  }

  return out
}

/**
 * Renders the receipt as fixed-width text.
 *
 * Used for tests, for the audit interface (§7.26) and as the reference the two
 * printer renderers are checked against.
 */
export function renderReceiptAsText(lines: ReceiptLine[], width = 48): string {
  const rendered: string[] = []

  for (const line of lines) {
    switch (line.kind) {
      case 'rule':
        rendered.push('-'.repeat(width))
        break
      case 'blank':
        rendered.push('')
        break
      case 'logo':
        rendered.push('[RRA LOGO]'.padStart(Math.floor((width + 10) / 2)))
        break
      case 'qr':
        rendered.push(`[QR: ${line.payload}]`)
        break
      case 'watermark':
        rendered.push(`[WATERMARK: ${line.text}]`)
        break
      case 'text':
        rendered.push(line.align === 'center' ? centre(line.text, width) : line.text)
        break
      case 'pair': {
        const gap = Math.max(1, width - line.left.length - line.right.length)
        rendered.push(`${line.left}${' '.repeat(gap)}${line.right}`)
        break
      }
    }
  }

  return rendered.join('\n')
}

function centre(text: string, width: number): string {
  if (text.length >= width) return text
  return ' '.repeat(Math.floor((width - text.length) / 2)) + text
}
