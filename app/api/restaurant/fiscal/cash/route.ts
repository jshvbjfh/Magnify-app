import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { endOfRestaurantDay, restaurantDayKey, startOfRestaurantDay } from '@/lib/restaurantDay'
import { resolveCurrentBusinessDate } from '@/lib/fiscalContext'
import { resolveCancellationApprover } from '@/lib/cancelApproval'
import { CASH_MOVEMENT_KINDS, requiresApproval, summarizeCashDrawer } from '@/lib/cashDrawer'
import { toVsdcPaymentMethod, VSDC_PAYMENT_METHOD } from '@/lib/vsdc/salesPayload'

export const dynamic = 'force-dynamic'

// The cash drawer (§7.12 — deposits and withdrawals can be registered), and the
// opening deposit every daily report has to state (§18.1.12).
//
// The arithmetic lives in lib/cashDrawer and is not repeated here. This route
// gathers what that function needs and applies the one control it does not: a
// supervisor's PIN before money leaves.
//
// ── Why a withdrawal needs a supervisor ─────────────────────────────────────
//
// Taking cash out is the movement that can hide a shortfall — a drawer counted
// short reconciles perfectly if someone recorded a withdrawal that never
// happened. It takes the same control a cancellation does and reuses the same
// PIN, so a venue keeps one list of people who may authorise money leaving
// rather than two that drift apart.

const VALID_KINDS: string[] = Object.values(CASH_MOVEMENT_KINDS)

// GET — the drawer for a business date.
//
//   ?date=YYYY-MM-DD   defaults to today at the restaurant
export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null
  if (!restaurantId || !branchId) return NextResponse.json({ error: 'No outlet selected' }, { status: 400 })

  const { searchParams } = new URL(req.url)
  const dateKey = searchParams.get('date') ?? restaurantDayKey()
  const from = startOfRestaurantDay(dateKey) ?? startOfRestaurantDay(restaurantDayKey())!
  const to = endOfRestaurantDay(dateKey) ?? endOfRestaurantDay(restaurantDayKey())!

  const [movements, settled] = await Promise.all([
    prisma.cashMovement.findMany({
      where: { branchId, businessDate: { gte: from, lte: to } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, kind: true, amount: true, reason: true,
        recordedByName: true, approvedByName: true, createdAt: true,
      },
    }),
    // Only what was tendered in CASH reaches the drawer. Card and mobile money
    // never do, and counting them would make the expected figure wrong by
    // exactly the amount that went through the card machine — which looks like
    // theft rather than like a bug.
    //
    // Classified by the same function that labels the tender for RRA, so the
    // drawer and the daily report can never disagree about what "cash" means.
    prisma.restaurantOrder.findMany({
      where: {
        branchId,
        deletedAt: null,
        status: 'PAID',
        OR: [
          { businessDate: { gte: from, lte: to } },
          { businessDate: null, paidAt: { gte: from, lte: to } },
        ],
      },
      select: { paymentMethod: true, totalAmount: true },
    }),
  ])

  const cashSales = settled
    .filter((order) => toVsdcPaymentMethod(order.paymentMethod) === VSDC_PAYMENT_METHOD.CASH)
    .reduce((sum, order) => sum + Number(order.totalAmount ?? 0), 0)

  return NextResponse.json({
    date: dateKey,
    movements: movements.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    // Refunds are zero until the refund path is wired; the drawer already
    // subtracts them, so nothing here changes when it is.
    summary: summarizeCashDrawer({ movements, cashSales, cashRefunds: 0 }),
  })
}

// POST — register a movement.
//
//   { kind, amount, reason?, supervisorPin? }
//
// A second opening float is deliberately allowed: lib/cashDrawer sums floats
// rather than taking the first, because correcting a miscounted float is done
// by adding the difference as another row. Refusing one here would break that.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null
  if (!restaurantId || !branchId) return NextResponse.json({ error: 'No outlet selected' }, { status: 400 })

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const kind = String(body.kind ?? '').trim().toUpperCase()
  const amount = Number(body.amount)
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''

  if (!VALID_KINDS.includes(kind)) {
    return NextResponse.json({ error: 'Choose a float, a deposit or a withdrawal' }, { status: 400 })
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: 'Enter an amount above zero' }, { status: 400 })
  }

  let approvedByName: string | null = null
  if (requiresApproval(kind)) {
    // Cash leaving with nothing written against it is the entry an auditor
    // asks about first, and the one nobody can answer months later.
    if (!reason) {
      return NextResponse.json({ error: 'Say what the cash is for' }, { status: 400 })
    }

    const approver = await resolveCancellationApprover({
      restaurantId,
      branchId,
      pin: String(body.supervisorPin ?? '').trim(),
    })
    if (!approver) {
      return NextResponse.json({ error: 'A supervisor PIN is required to take cash out' }, { status: 403 })
    }
    approvedByName = approver.name ?? null
  }

  const { businessDate, shiftId } = await resolveCurrentBusinessDate(prisma, restaurantId)

  const movement = await prisma.cashMovement.create({
    data: {
      restaurantId,
      branchId,
      shiftId,
      businessDate,
      kind,
      amount,
      reason: reason || null,
      recordedByName: session.user.name?.trim() || null,
      approvedByName,
    },
    select: {
      id: true, kind: true, amount: true, reason: true,
      recordedByName: true, approvedByName: true, createdAt: true,
    },
  })

  return NextResponse.json({ ...movement, createdAt: movement.createdAt.toISOString() }, { status: 201 })
}
