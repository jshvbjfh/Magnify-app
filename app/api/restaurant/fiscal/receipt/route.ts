import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { loadFiscalOutlet } from '@/lib/fiscalContext'
import { buildReceiptInputFromOrder } from '@/lib/fiscalReceiptBuilder'
import { FISCAL_RECEIPT_TYPES, type FiscalReceiptType } from '@/lib/fiscalCounter'
import { buildFiscalReceipt, renderReceiptAsText } from '@/lib/vsdc/fiscalReceipt'
import { renderReceiptAsHtml } from '@/lib/vsdc/htmlRenderer'
import { describeEscposGaps } from '@/lib/vsdc/escposRenderer'

export const dynamic = 'force-dynamic'

// Rendering a receipt (§13, §11, §6.3.6).
//
//   GET ?orderId=...&type=PS|TS&format=json|text|html
//
// ── Which types this can produce today ──────────────────────────────────────
//
// PROFORMA and TRAINING only, and that limit is the specification's rather than
// a shortcut. Both are unsigned by §6.3.6, so both can be produced with no
// controller in the room:
//
//   PS  the bill a guest asks for before paying
//   TS  a training ticket, for staff being taught the till
//
// NS, NR and CS all carry a VSDC signature and a receipt number claimed from
// the fiscal counter. Issuing one is a settlement act, not a rendering act —
// it belongs to the settlement path, and producing one here would mean printing
// a receipt the controller never saw, which §10 forbids outright.
//
// So this route renders; it never issues. Nothing here writes a FiscalReceipt
// row or moves a counter.
const RENDERABLE: FiscalReceiptType[] = [FISCAL_RECEIPT_TYPES.PROFORMA, FISCAL_RECEIPT_TYPES.TRAINING]

export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null
  if (!restaurantId || !branchId) return NextResponse.json({ error: 'No outlet selected' }, { status: 400 })

  const { searchParams } = new URL(req.url)
  const orderId = String(searchParams.get('orderId') ?? '').trim()
  const receiptType = String(searchParams.get('type') ?? FISCAL_RECEIPT_TYPES.PROFORMA).toUpperCase() as FiscalReceiptType
  const format = String(searchParams.get('format') ?? 'json').toLowerCase()

  if (!orderId) return NextResponse.json({ error: 'Which bill?' }, { status: 400 })

  if (!RENDERABLE.includes(receiptType)) {
    return NextResponse.json(
      { error: 'Only proforma and training tickets can be rendered here — a sale receipt is issued at settlement' },
      { status: 400 },
    )
  }

  const outletResult = await loadFiscalOutlet(prisma, restaurantId, branchId)
  if (!outletResult.ok) return NextResponse.json({ error: outletResult.gap }, { status: 409 })

  const order = await prisma.restaurantOrder.findFirst({
    where: { id: orderId, restaurantId, deletedAt: null },
    select: {
      orderNumber: true,
      createdAt: true,
      paymentMethod: true,
      items: {
        where: { status: 'ACTIVE' },
        select: { dishName: true, dishPrice: true, qty: true, discountPercent: true, notes: true, dish: { select: { taxCategory: true } } },
        orderBy: { createdAt: 'asc' },
      },
    },
  })

  if (!order) return NextResponse.json({ error: 'Bill not found' }, { status: 404 })

  const input = buildReceiptInputFromOrder({
    order: {
      orderNumber: order.orderNumber,
      createdAt: order.createdAt,
      paymentMethod: order.paymentMethod,
      items: order.items.map((item) => ({
        dishName: item.dishName,
        dishPrice: Number(item.dishPrice),
        qty: Number(item.qty),
        discountPercent: item.discountPercent,
        // The bracket lives on the dish, not on the line: a dish reclassified
        // after the bill was opened should be declared as it is classified now.
        taxCategory: item.dish?.taxCategory ?? null,
        notes: item.notes,
      })),
    },
    outlet: outletResult.outlet,
    receiptType,
  })

  const lines = buildFiscalReceipt(input)

  if (format === 'text') {
    return new NextResponse(renderReceiptAsText(lines), {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  if (format === 'html') {
    return new NextResponse(renderReceiptAsHtml(lines), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  }

  return NextResponse.json({
    receiptType,
    lines,
    text: renderReceiptAsText(lines),
    html: renderReceiptAsHtml(lines),
    totals: {
      totalAmount: input.totalAmount,
      totalTaxAmount: input.totalTaxAmount,
      taxBreakdown: input.taxBreakdown,
      itemCount: input.lines.length,
    },
    // What this receipt could not print, named rather than silently dropped:
    // the RRA logo has no artwork yet, and a watermark needs one too.
    gaps: describeEscposGaps(lines),
  })
}
