// Turning one of Magnify's bills into the receipt RRA specifies.
//
// lib/vsdc/fiscalReceipt lays a receipt out from figures it is given; it does
// not know what an order is. This is the join between the two — the only place
// that reads an order's shape and produces a FiscalReceiptInput.
//
// Kept out of the route so it can be tested without a database, and kept in one
// place so the proforma a guest is shown, the receipt they are handed and the
// copy they are given later cannot be built by three different routes that
// disagree about the totals.
//
// PURE: an order-shaped object in, a receipt input out.

import { FISCAL_RECEIPT_TYPES, type FiscalReceiptType } from '@/lib/fiscalCounter'
import { calculateRestaurantOrderTotals, summarizeTaxByCategory } from '@/lib/restaurantOrders'
import { normalizeTaxCategory, rateForTaxCategory, round2 } from '@/lib/restaurantVat'
import type { FiscalReceiptInput, VsdcResponse } from '@/lib/vsdc/fiscalReceipt'

export type OrderLineForReceipt = {
  dishName: string
  dishPrice: number
  qty: number
  discountPercent?: number | null
  taxCategory?: string | null
  notes?: string | null
}

export type OrderForReceipt = {
  orderNumber: string | number
  createdAt: Date | string
  paymentMethod?: string | null
  customerTin?: string | null
  items: OrderLineForReceipt[]
}

export type OutletForReceipt = {
  tradeName: string
  address?: string | null
  tin: string
  mrc: string
}

/** dd/mm/yyyy and hh:mm:ss, the shape §13.1 prints. */
export function splitDateTime(value: Date | string): { date: string; time: string } {
  const date = value instanceof Date ? value : new Date(value)
  const iso = (Number.isNaN(date.getTime()) ? new Date() : date).toISOString()
  return {
    date: `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`,
    time: iso.slice(11, 19),
  }
}

export function buildReceiptInputFromOrder(params: {
  order: OrderForReceipt
  outlet: OutletForReceipt
  receiptType: FiscalReceiptType
  paymentLabel?: string | null
  topMessage?: string | null
  bottomMessage?: string | null
  /** Absent for training and proforma, which are never signed (§6.3.6). */
  vsdc?: VsdcResponse | null
  refundedReceiptNumber?: string | null
}): FiscalReceiptInput {
  const { order, outlet } = params

  // Fiscal mode is forced on here rather than read from the build. A proforma
  // shown on a non-fiscal build must still be laid out the fiscal way, or the
  // preview would not match the receipt that follows it.
  const totals = calculateRestaurantOrderTotals(
    order.items.map((item) => ({
      dishPrice: Number(item.dishPrice),
      qty: Number(item.qty),
      discountPercent: item.discountPercent,
      taxCategory: item.taxCategory,
    })),
    { fiscalMode: true },
  )

  const brackets = summarizeTaxByCategory(totals.taxLines)
  const stamp = splitDateTime(order.createdAt)

  return {
    receiptType: params.receiptType,
    tradeName: outlet.tradeName,
    address: outlet.address ?? null,
    tin: outlet.tin,
    mrc: outlet.mrc,
    topMessage: params.topMessage ?? null,
    bottomMessage: params.bottomMessage ?? null,
    customerTin: order.customerTin ?? null,
    refundedReceiptNumber: params.refundedReceiptNumber ?? null,

    lines: order.items.map((item, index) => ({
      name: item.dishName,
      unitPrice: round2(Number(item.dishPrice)),
      qty: Number(item.qty),
      discountPercent: item.discountPercent ?? null,
      taxCategory: normalizeTaxCategory(item.taxCategory),
      // The line's charge after discount, from the same calculation that
      // produced the totals — never recomputed here, or a rounding difference
      // would put the lines and the total a franc apart on the same page.
      chargedAmount: totals.taxLines[index]?.grossAmount ?? 0,
      notes: item.notes ?? null,
    })),

    // §7.22 — the brackets actually present on this bill, in order.
    taxBreakdown: brackets.map((bracket) => ({
      category: bracket.category,
      ratePercent: round2(rateForTaxCategory(bracket.category) * 100),
      grossAmount: bracket.grossAmount,
      taxAmount: bracket.taxAmount,
    })),

    totalAmount: totals.totalAmount,
    // From the brackets, matching what prints per bracket directly above it —
    // see summarizeTaxByCategory for why this is not the sum of the lines.
    totalTaxAmount: round2(brackets.reduce((sum, bracket) => sum + bracket.taxAmount, 0)),

    paymentLabel: params.paymentLabel ?? order.paymentMethod ?? 'CASH',

    cisReceiptNumber: String(order.orderNumber),
    cisDate: stamp.date,
    cisTime: stamp.time,

    // §6.3.6 — training and proforma tickets are never digitally signed, so the
    // VSDC block is dropped for them however the caller was called.
    vsdc:
      params.receiptType === FISCAL_RECEIPT_TYPES.TRAINING ||
      params.receiptType === FISCAL_RECEIPT_TYPES.PROFORMA
        ? null
        : params.vsdc ?? null,
  }
}
