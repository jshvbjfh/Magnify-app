import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { endOfRestaurantDay, startOfRestaurantDay } from '@/lib/restaurantDay'
import { ACTIVE_RESTAURANT_ORDER_STATUSES, NO_CHARGE_METHOD_VALUES } from '@/lib/restaurantOrders'
import { loadFiscalOutlet } from '@/lib/fiscalContext'
import {
  buildDailyReport,
  renderDailyReportAsText,
  summarizeDailyReport,
  type DailyReportInput,
  type ReportReceipt,
} from '@/lib/vsdc/dailyReport'
import type { FiscalReceiptType } from '@/lib/fiscalCounter'

// A report of the day's takings must never be served from a cache.
export const dynamic = 'force-dynamic'

// GET — the Z or X daily report (§7.6, §18.1).
//
//   ?kind=Z|X
//   ?date=YYYY-MM-DD   the business date, Z only; defaults to today
//   ?since=ISO         X only; when the last Z was taken
//
// ── Which receipts count ────────────────────────────────────────────────────
//
// Only receipts the controller answered. §10 forbids printing before the VSDC
// responds, so a PENDING row was never handed to a guest and is not part of the
// day's declared sales. Counting it would make the report disagree with the
// paper it summarises, which is the one thing a Z report may not do.
//
// PENDING rows are still reported, separately, as `pending` — an operator whose
// day ends with unsent receipts needs to see that before closing.
//
// ── The X window ────────────────────────────────────────────────────────────
//
// §7.6 defines X as covering everything since the last Z, NOT since the last X.
// The caller passes `since` because when the last Z was taken is not yet stored
// anywhere — recording it needs one small table, which is the last piece of
// F-02. Absent `since`, the window opens at the start of the current business
// date, which is the same answer in any venue that takes its Z at close of
// service, and a shorter one than the truth in a venue that skipped a day.
// Short is the safe direction to be wrong in: it under-reports the window
// rather than double-counting a day already closed by a Z.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null
  if (!restaurantId || !branchId) {
    return NextResponse.json({ error: 'No outlet selected' }, { status: 400 })
  }

  const { searchParams } = new URL(req.url)
  const kind = String(searchParams.get('kind') ?? 'Z').toUpperCase() === 'X' ? 'X' : 'Z'

  const outletResult = await loadFiscalOutlet(prisma, restaurantId, branchId)
  if (!outletResult.ok) {
    // Not an error the operator caused, and not one they can work around — it
    // is the till telling them registration is unfinished.
    return NextResponse.json({ error: outletResult.gap }, { status: 409 })
  }
  const outlet = outletResult.outlet

  const dateParam = searchParams.get('date')
  const dayStart = startOfRestaurantDay(dateParam) ?? startOfRestaurantDay(new Date().toISOString().slice(0, 10))!
  const dayEnd = endOfRestaurantDay(dateParam) ?? endOfRestaurantDay(new Date().toISOString().slice(0, 10))!

  const sinceParam = searchParams.get('since')
  const sinceDate = sinceParam ? new Date(sinceParam) : null
  const windowStart = kind === 'X' && sinceDate && !Number.isNaN(sinceDate.getTime()) ? sinceDate : dayStart
  const windowEnd = kind === 'X' ? new Date() : dayEnd

  const [rows, floats, incompleteSales, compedOrders] = await Promise.all([
    prisma.fiscalReceipt.findMany({
      where: { branchId, businessDate: { gte: windowStart, lte: windowEnd } },
      select: {
        receiptType: true,
        status: true,
        totalAmount: true,
        taxableAmtA: true, taxableAmtB: true, taxableAmtC: true, taxableAmtD: true,
        taxAmtA: true, taxAmtB: true, taxAmtC: true, taxAmtD: true,
        itemCount: true,
        discountTotal: true,
        paymentTypeCode: true,
      },
      orderBy: { invoiceNumber: 'asc' },
    }),
    // §18.1.12 — what was in the drawer before trading began.
    prisma.cashMovement.findMany({
      where: { branchId, kind: 'OPENING_FLOAT', businessDate: { gte: windowStart, lte: windowEnd } },
      select: { amount: true },
    }),
    // §18.1.20 — bills opened and never settled.
    //
    // Named by what an incomplete sale IS, not by excluding the settled ones.
    // The exclusion list is the trap here: the status is spelled CANCELED with
    // one L, there is also MERGED, and a QR order sits at UNCONFIRMED before a
    // waiter has accepted it. Every one of those is a concluded or not-yet-
    // started bill, and any missed from a `notIn` would be reported to RRA as
    // an unfinished sale. ACTIVE_RESTAURANT_ORDER_STATUSES is the set the rest
    // of the app already means by "still open".
    prisma.restaurantOrder.count({
      where: {
        branchId,
        deletedAt: null,
        status: { in: [...ACTIVE_RESTAURANT_ORDER_STATUSES] },
        // businessDate is null where the venue runs no shifts. An unsettled
        // bill has no paidAt to fall back on either, so it falls to when it
        // was opened.
        OR: [
          { businessDate: { gte: windowStart, lte: windowEnd } },
          { businessDate: null, createdAt: { gte: windowStart, lte: windowEnd } },
        ],
      },
    }),
    // §18.1.19 — food that left the kitchen against no money. A comped bill
    // stores zero with its value in compedAmount, so this is the only place the
    // day's giveaway is visible.
    prisma.restaurantOrder.findMany({
      where: {
        branchId,
        deletedAt: null,
        status: 'PAID',
        paymentMethod: { in: NO_CHARGE_METHOD_VALUES },
        // Same null-businessDate fallback the No Charge report uses, for the
        // same reason: a venue running no shifts stamps none, and those comps
        // would otherwise vanish from the day they were given away on.
        OR: [
          { businessDate: { gte: windowStart, lte: windowEnd } },
          { businessDate: null, paidAt: { gte: windowStart, lte: windowEnd } },
        ],
      },
      select: { orderNumber: true, compedAmount: true },
    }),
  ])

  const issued = rows.filter((row) => row.status === 'SENT')
  const pending = rows.filter((row) => row.status === 'PENDING')
  const failed = rows.filter((row) => row.status === 'FAILED')

  const receipts: ReportReceipt[] = issued.map((row) => ({
    receiptType: row.receiptType as FiscalReceiptType,
    totalAmount: row.totalAmount,
    taxableByCategory: { A: row.taxableAmtA, B: row.taxableAmtB, C: row.taxableAmtC, D: row.taxableAmtD },
    taxByCategory: { A: row.taxAmtA, B: row.taxAmtB, C: row.taxAmtC, D: row.taxAmtD },
    itemCount: row.itemCount,
    discountTotal: row.discountTotal,
    paymentTypeCode: row.paymentTypeCode,
  }))

  const takenAt = new Date()
  const stamp = takenAt.toISOString()

  const input: DailyReportInput = {
    kind,
    tradeName: outlet.tradeName,
    tin: outlet.tin,
    mrc: outlet.mrc,
    cisDesignation: outlet.cisDesignation,
    // §18.1.2 — dd/mm/yyyy and hh:mm:ss, the same shape the receipt uses.
    date: `${stamp.slice(8, 10)}/${stamp.slice(5, 7)}/${stamp.slice(0, 4)}`,
    time: stamp.slice(11, 19),
    periodLabel:
      kind === 'Z'
        ? `Business date ${dayStart.toISOString().slice(0, 10)}`
        : `Since ${windowStart.toISOString().replace('T', ' ').slice(0, 19)}`,
    openingDeposit: floats.reduce((sum, row) => sum + Number(row.amount ?? 0), 0),
    incompleteSalesCount: incompleteSales,
    otherReductions: compedOrders
      .filter((order) => Number(order.compedAmount ?? 0) > 0)
      .map((order) => ({ label: `Comped bill ${order.orderNumber}`, amount: Number(order.compedAmount ?? 0) })),
    receipts,
  }

  const summary = summarizeDailyReport(input)
  const lines = buildDailyReport(input)

  return NextResponse.json({
    kind,
    outlet: { tradeName: outlet.tradeName, tin: outlet.tin, mrc: outlet.mrc, cisDesignation: outlet.cisDesignation },
    window: { from: windowStart.toISOString(), to: windowEnd.toISOString(), label: input.periodLabel },
    takenAt: stamp,
    // The computed figures, for the screen.
    summary: {
      ...summary,
      // A Map does not survive JSON. §18.1.17 needs the tender split, so it
      // travels as an array and keeps its order.
      byPayment: [...summary.byPayment.entries()].map(([code, value]) => ({ code, ...value })),
    },
    // The laid-out report, for the printer and for the on-screen preview.
    lines,
    text: renderDailyReportAsText(input),
    // Not part of §18. Operational truth the person closing the day needs.
    unsent: { pending: pending.length, failed: failed.length },
  })
}
