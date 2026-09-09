import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { endOfRestaurantDay, restaurantDayKey, startOfRestaurantDay } from '@/lib/restaurantDay'
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
// Taking X twice in a service would otherwise show the second one as almost
// empty, which is the mistake the clause is worded to prevent.
//
// The window therefore opens at `coveredTo` of the most recent Z — the instant
// that report actually closed at, not the date boundary it was filed under,
// because a Z taken at 01:40 covers the night that opened the previous
// calendar day. Where no Z has ever been taken the window opens at the start
// of the current business date, which is all there is to go on.
//
// `since` overrides both, for an operator reconciling a specific window.
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

  // Defaults to today AT THE RESTAURANT. toISOString() would read the day in
  // UTC, which between midnight and 02:00 in Kigali is still yesterday — a Z
  // report taken at closing time would then summarise the wrong day.
  const dateParam = searchParams.get('date') ?? restaurantDayKey()
  const dayStart = startOfRestaurantDay(dateParam) ?? startOfRestaurantDay(restaurantDayKey())!
  const dayEnd = endOfRestaurantDay(dateParam) ?? endOfRestaurantDay(restaurantDayKey())!

  // Where the last Z left off. Only consulted for an X — a Z is defined by its
  // own business date, not by what preceded it.
  const lastZ =
    kind === 'X'
      ? await prisma.fiscalDailyReport.findFirst({
          where: { branchId, kind: 'Z' },
          orderBy: { coveredTo: 'desc' },
          select: { coveredTo: true, businessDate: true, takenAt: true },
        })
      : null

  const sinceParam = searchParams.get('since')
  const sinceDate = sinceParam ? new Date(sinceParam) : null
  const explicitSince = sinceDate && !Number.isNaN(sinceDate.getTime()) ? sinceDate : null

  const windowStart =
    kind === 'X'
      ? explicitSince ?? lastZ?.coveredTo ?? dayStart
      : dayStart
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
        // dateParam, not dayStart — the window's first instant is 22:00 UTC on
        // the PREVIOUS day, so printing it back would label the report with the
        // wrong date even though it covers the right one.
        ? `Business date ${dateParam}`
        // An X says what it is measured FROM, because that is the question an
        // operator taking a second one mid-service is actually asking.
        : lastZ && !explicitSince
          ? `Since the Z of ${lastZ.businessDate.toISOString().slice(0, 10)}`
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
    // For an X: which Z it is measured from, so the screen can say so.
    sinceLastZ: lastZ ? { businessDate: lastZ.businessDate.toISOString(), takenAt: lastZ.takenAt.toISOString() } : null,
  })
}

// POST — take the Z, and close the trading day (§7.6).
//
//   { date?: 'YYYY-MM-DD' }   defaults to today at the restaurant
//
// Taking a Z is not the same act as reading one. GET renders the figures as
// often as anyone likes and changes nothing; this records that the day was
// closed, which is what every later X measures itself from.
//
// The figures are STORED as declared rather than recomputed on demand, for the
// same reason fiscal_receipts stores its own: reprinting this Z next year must
// reproduce the numbers that were declared on the night, not the numbers a
// later rounding rule would produce.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null
  if (!restaurantId || !branchId) return NextResponse.json({ error: 'No outlet selected' }, { status: 400 })

  const outletResult = await loadFiscalOutlet(prisma, restaurantId, branchId)
  if (!outletResult.ok) return NextResponse.json({ error: outletResult.gap }, { status: 409 })

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const dateKey = typeof body.date === 'string' && body.date.trim() ? body.date.trim() : restaurantDayKey()
  const from = startOfRestaurantDay(dateKey)
  const to = endOfRestaurantDay(dateKey)
  if (!from || !to) return NextResponse.json({ error: 'That is not a date' }, { status: 400 })

  const issued = await prisma.fiscalReceipt.findMany({
    where: { branchId, businessDate: { gte: from, lte: to }, status: 'SENT' },
    select: { receiptType: true, totalAmount: true, totalTaxAmount: true },
  })

  const sales = issued.filter((row) => row.receiptType === 'NS')
  const refunds = issued.filter((row) => row.receiptType === 'NR')
  const round2 = (value: number) => Math.round(value * 100) / 100

  try {
    const record = await prisma.fiscalDailyReport.create({
      data: {
        restaurantId,
        branchId,
        kind: 'Z',
        businessDate: from,
        coveredFrom: from,
        // Closed at the moment it was taken, not at the end of the calendar
        // day — a Z taken at 01:40 must not claim to cover the twenty-two
        // hours that have not happened yet. The next X opens here.
        coveredTo: new Date(),
        takenByName: session.user.name?.trim() || null,
        salesCount: sales.length,
        salesTotal: round2(sales.reduce((sum, row) => sum + row.totalAmount, 0)),
        refundCount: refunds.length,
        refundTotal: round2(refunds.reduce((sum, row) => sum + row.totalAmount, 0)),
        totalTax: round2(issued.reduce((sum, row) => sum + row.totalTaxAmount, 0)),
      },
    })

    return NextResponse.json({ closed: true, report: record }, { status: 201 })
  } catch (error) {
    // The unique index on (branchId, kind, businessDate) is the guard: a day is
    // closed once. A second Z would reopen and re-summarise a day already
    // declared, and every X taken since would silently change its window.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return NextResponse.json({ error: 'That day has already been closed with a Z report' }, { status: 409 })
    }
    throw error
  }
}
