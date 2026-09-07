import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { resolveCancellationApprover } from '@/lib/cancelApproval'
import { isFiscalBuild } from '@/lib/fiscalMode'
import { resolveCurrentBusinessDate } from '@/lib/fiscalContext'
import { claimFiscalReceiptNumber, FISCAL_RECEIPT_TYPES, type FiscalReceiptType } from '@/lib/fiscalCounter'
import {
  describeRefundPlan,
  describeRefundRefusal,
  RESTAURANT_REFUND_REASONS,
  REFUND_REASON_LABELS,
  type OriginalReceipt,
} from '@/lib/vsdc/fiscalRefund'

export const dynamic = 'force-dynamic'

// Refunds (§7.17).
//
//   "a transaction may not be corrected without prior cancellation of the
//    original ... each cancellation must reference the original receipt number
//    ... an original may be cancelled only once"
//
// A refund receipt (NR) is the ONLY way to undo a settled sale. The original
// never disappears — it is referenced, and both stay in the journal, which is
// what lets RRA see that a reversal happened rather than that a sale vanished.
//
//   GET  ?invoiceNumber=...   what the refund would look like, and why not
//   POST                      issue it
//
// ── Why a refund may be refused as "not reached RRA yet" ────────────────────
//
// A sale still PENDING has not been declared. There is nothing on RRA's side to
// reverse, so reversing it here would put a refund into the sequence against a
// sale they never received. That refusal is expected until the controller is
// connected, and is not a defect in this route.

async function loadOriginal(branchId: string, invoiceNumber: number) {
  const [original, existingRefunds] = await Promise.all([
    prisma.fiscalReceipt.findFirst({
      where: { branchId, invoiceNumber },
      select: { receiptType: true, invoiceNumber: true, totalAmount: true, status: true, branchId: true, orderId: true },
    }),
    prisma.fiscalReceipt.findMany({
      where: { branchId, receiptType: FISCAL_RECEIPT_TYPES.REFUND, originalInvoiceNumber: invoiceNumber },
      select: { invoiceNumber: true },
    }),
  ])
  return { original, existingRefunds }
}

export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const branchId = context?.branchId ?? null
  if (!branchId) return NextResponse.json({ error: 'No outlet selected' }, { status: 400 })

  const { searchParams } = new URL(req.url)
  const invoiceNumber = Number(searchParams.get('invoiceNumber'))
  if (!Number.isInteger(invoiceNumber) || invoiceNumber <= 0) {
    return NextResponse.json({ error: 'Which receipt?' }, { status: 400 })
  }

  const { original, existingRefunds } = await loadOriginal(branchId, invoiceNumber)

  // The plan is asked for with a placeholder reason and approver so the screen
  // can show the amount and the once-only warning BEFORE a supervisor is
  // fetched. The refusals that matter — wrong station, already refunded, not
  // yet declared — all answer without either.
  const plan = describeRefundPlan({
    original: original as OriginalReceipt | null,
    existingRefunds,
    reasonCode: RESTAURANT_REFUND_REASONS[0],
    approvedByName: 'preview',
    branchId,
  })

  return NextResponse.json({
    ...plan,
    reasons: RESTAURANT_REFUND_REASONS.map((code) => ({ code, label: REFUND_REASON_LABELS[code] ?? code })),
  })
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null
  if (!restaurantId || !branchId) return NextResponse.json({ error: 'No outlet selected' }, { status: 400 })

  if (!isFiscalBuild()) {
    return NextResponse.json({ error: 'This build does not issue fiscal receipts' }, { status: 400 })
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const invoiceNumber = Number(body.invoiceNumber)
  const reasonCode = String(body.reasonCode ?? '').trim()

  if (!Number.isInteger(invoiceNumber) || invoiceNumber <= 0) {
    return NextResponse.json({ error: 'Which receipt?' }, { status: 400 })
  }

  const approver = await resolveCancellationApprover({
    restaurantId,
    branchId,
    pin: String(body.supervisorPin ?? '').trim(),
  })

  const { original, existingRefunds } = await loadOriginal(branchId, invoiceNumber)

  const request = {
    original: original as OriginalReceipt | null,
    existingRefunds,
    reasonCode,
    approvedByName: approver?.name ?? null,
    branchId,
  }

  const refusal = describeRefundRefusal(request)
  if (refusal) {
    return NextResponse.json({ error: refusal }, { status: approver ? 409 : 403 })
  }

  const { businessDate } = await resolveCurrentBusinessDate(prisma, restaurantId)

  const refund = await prisma.$transaction(async (tx) => {
    // §7.17 is enforced in code rather than by a unique index, because a COPY
    // also references the receipt it copies and §7.18 places no limit on those.
    // Re-checked INSIDE the transaction: two supervisors refunding the same
    // bill in the same instant would both pass the check above.
    const raced = await tx.fiscalReceipt.count({
      where: { branchId, receiptType: FISCAL_RECEIPT_TYPES.REFUND, originalInvoiceNumber: invoiceNumber },
    })
    if (raced > 0) {
      throw new Error('That bill has already been refunded — a bill can only be refunded once')
    }

    const numbers = await claimFiscalReceiptNumber(tx, {
      restaurantId,
      branchId,
      receiptType: FISCAL_RECEIPT_TYPES.REFUND as FiscalReceiptType,
    })

    // Stored POSITIVE, with the receipt type carrying the direction. The
    // reports negate refunds when they summarise, and the receipt prints them
    // negative — a stored negative would be subtracted twice.
    const source = await tx.fiscalReceipt.findFirst({
      where: { branchId, invoiceNumber },
    })

    return tx.fiscalReceipt.create({
      data: {
        restaurantId,
        branchId,
        orderId: source?.orderId ?? null,
        receiptType: FISCAL_RECEIPT_TYPES.REFUND,
        invoiceNumber: numbers.totalNumber,
        originalInvoiceNumber: invoiceNumber,
        paymentTypeCode: source?.paymentTypeCode ?? null,
        totalAmount: source?.totalAmount ?? 0,
        totalTaxableAmount: source?.totalTaxableAmount ?? 0,
        totalTaxAmount: source?.totalTaxAmount ?? 0,
        taxableAmtA: source?.taxableAmtA ?? 0,
        taxableAmtB: source?.taxableAmtB ?? 0,
        taxableAmtC: source?.taxableAmtC ?? 0,
        taxableAmtD: source?.taxableAmtD ?? 0,
        taxAmtA: source?.taxAmtA ?? 0,
        taxAmtB: source?.taxAmtB ?? 0,
        taxAmtC: source?.taxAmtC ?? 0,
        taxAmtD: source?.taxAmtD ?? 0,
        itemCount: source?.itemCount ?? 0,
        discountTotal: source?.discountTotal ?? 0,
        status: 'PENDING',
        businessDate,
      },
    })
  })

  return NextResponse.json({
    refunded: true,
    originalInvoiceNumber: invoiceNumber,
    refundInvoiceNumber: refund.invoiceNumber,
    amount: refund.totalAmount,
    reasonCode,
    approvedByName: approver?.name ?? null,
  }, { status: 201 })
}
