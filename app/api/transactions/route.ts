import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { databaseUnavailableJson, isPrismaDatabaseUnavailableError, logDatabaseUnavailable } from '@/lib/apiDatabase'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { recordJournalEntry, recordVatJournalEntry } from '@/lib/accounting'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { endOfRestaurantDay, startOfRestaurantDay } from '@/lib/restaurantDay'

// Money must never be served from a cache. Without this, Next can cache the
// GET response and keep returning figures from before a correction landed —
// the page looks fine, refreshes cleanly, and still shows yesterday's numbers.
export const dynamic = 'force-dynamic'

class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized')
  }
}

function parseAmount(raw: unknown): number {
  if (typeof raw === 'number') return raw
  const s = String(raw ?? '').trim()
  if (!s) return NaN
  const cleaned = s.replace(/[^0-9.\-]/g, '').replace(/(\..*)\./g, '$1')
  return Number(cleaned)
}

function parseDateOrNow(raw: unknown): Date {
  if (!raw) return new Date()
  const s = String(raw)
  // YYYY-MM-DD from <input type="date"> — anchor to noon Kigali (UTC+2) to avoid date-shifting
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T10:00:00Z`)
  const d = new Date(s)
  return Number.isFinite(d.getTime()) ? d : new Date()
}

async function requireContext() {
  const session = await getServerSession(authOptions)
  const userId = session?.user?.id
  if (!userId) throw new UnauthorizedError()
  const { restaurantId, branchId } = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  return { userId, restaurantId, branchId }
}

export async function GET(req: Request) {
  try {
    const context = await requireContext()

    if (!context.restaurantId || !context.branchId) {
      return new NextResponse('No restaurant station linked to this account. Contact your administrator.', { status: 400 })
    }

    const { searchParams } = new URL(req.url)
    const startDate = searchParams.get('startDate')
    const endDate = searchParams.get('endDate')
    const rangeStart = startDate && endDate ? startOfRestaurantDay(startDate) : null
    const rangeEnd = startDate && endDate ? endOfRestaurantDay(endDate) : null

    // The station to report on comes from the caller when supplied, not the session.
    // Switching stations updates the session JWT asynchronously, so a fetch fired
    // right after a switch could otherwise still be scoped to the previous station
    // (and stay wrong indefinitely if that background session update ever fails).
    // Always validated against this user's own restaurant before it is trusted.
    const requestedBranchId = searchParams.get('branchId')?.trim() || null
    const activeBranch = await prisma.branch.findFirst({
      where: {
        id: requestedBranchId ?? context.branchId,
        restaurantId: context.restaurantId,
      },
      select: { id: true, isMain: true },
    })

    if (!activeBranch) {
      return new NextResponse('Station not found for this account.', { status: 400 })
    }

    // Main is the whole-restaurant view — every station's entries, unseparated —
    // rather than a station scoped to its own transactions like the rest.
    const branchFilter = activeBranch.isMain ? {} : { branchId: activeBranch.id }

    // Older history can be hidden from this page without deleting it: the rows
    // stay in the database (keeping stock, purchase records and audits intact)
    // and clearing the restaurant's historyVisibleFrom brings them straight back.
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: context.restaurantId },
      select: { historyVisibleFrom: true },
    })
    // Both bounds live on entryDate, so they are merged into one condition —
    // spreading them separately would let a date range silently override the
    // hidden-history cutoff and expose the entries it is meant to hide. The
    // later of the two start bounds always wins.
    const historyStart = restaurant?.historyVisibleFrom ?? null
    const effectiveStart = historyStart && rangeStart
      ? (historyStart > rangeStart ? historyStart : rangeStart)
      : (historyStart ?? rangeStart)

    const dateBounds = {
      ...(effectiveStart ? { gte: effectiveStart } : {}),
      ...(rangeEnd ? { lte: rangeEnd } : {}),
    }

    // An entry's day is its shift's businessDate when it has one, else its
    // entryDate. The cutoff and any range both apply to that effective day, so
    // an order paid at 1am under a 6am shift is filtered on the shift's day —
    // while manual/legacy entries (no businessDate) keep their entryDate.
    const entries = await prisma.journalEntry.findMany({
      where: {
        restaurantId: context.restaurantId,
        ...branchFilter,
        ...(Object.keys(dateBounds).length > 0
          ? {
              OR: [
                { businessDate: dateBounds },
                { businessDate: null, entryDate: dateBounds },
              ],
            }
          : {}),
      },
      include: {
        lines: {
          include: { account: { include: { category: true } } },
        },
      },
      orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }],
    })

    return NextResponse.json({
      transactions: entries.map((entry) => {
        const drLine = entry.lines.find((l) => l.debit > 0)
        const crLine = entry.lines.find((l) => l.credit > 0)
        const amount = drLine?.debit ?? crLine?.credit ?? 0
        // Income entry: CR is revenue → direction 'in', show revenue account as main
        const isIncome = crLine?.account?.category?.type === 'income'

        // Collecting a receivable books DR <tender> / CR Accounts Receivable —
        // both sides are assets, so the income test above says "not income" and
        // the entry would come out backwards: direction 'out', with the tender
        // reported as 'Accounts Receivable'. Cash Flow keys off that name, so a
        // debt paid in cash was dropped from the cash report altogether and
        // shown as money leaving. It is the opposite: the money arrived.
        //
        // Paying a supplier (DR Accounts Payable / CR Cash) already comes out
        // right, so only the receivable side is special-cased here.
        const isCollection = /receivable/i.test(crLine?.account?.name ?? '')

        const mainAccount = isIncome || isCollection ? (crLine?.account ?? null) : (drLine?.account ?? null)
        // Settlement account holds the cash/bank/asset side used for payment method detection
        const settlementAccount = isIncome || isCollection ? (drLine?.account ?? null) : (crLine?.account ?? null)
        return {
          id: entry.id,
          pairId: entry.id,
          date: entry.entryDate.toISOString(),
          createdAt: entry.createdAt.toISOString(),
          description: entry.description,
          amount,
          direction: isIncome || isCollection ? 'in' : 'out',
          accountName: mainAccount?.name ?? '',
          categoryType: mainAccount?.category?.type ?? 'expense',
          paymentMethod: settlementAccount?.name ?? null,
          reference: entry.reference ?? null,
          isManual: entry.reference === 'manual',
          sourceKind: null,
          uploadId: null,
          screenshotUrl: null,
        }
      }),
    })
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return new NextResponse('Unauthorized', { status: 401 })
    }

    if (isPrismaDatabaseUnavailableError(error)) {
      logDatabaseUnavailable('api/transactions GET', error)
      return databaseUnavailableJson({
        body: { transactions: [] },
        message: 'Transactions are temporarily unavailable while the database connection is down.',
      })
    }

    console.error('Error fetching transactions:', error)
    return new NextResponse('Failed to load transactions', { status: 500 })
  }
}

export async function POST(req: Request) {
  try {
    const context = await requireContext()
    if (!context.restaurantId || !context.branchId) {
      return new NextResponse('No restaurant station found for this write operation', { status: 400 })
    }

    const body = await req.json()

    // Same reasoning as GET: trust the caller's station when supplied (validated
    // against this restaurant) so an entry recorded right after a station switch
    // can't be filed under the station the user just left. Main records its own
    // entries normally — the whole-restaurant view is a read-side concern only.
    const requestedBranchId = typeof body.branchId === 'string' ? body.branchId.trim() : ''
    const writeBranch = await prisma.branch.findFirst({
      where: {
        id: requestedBranchId || context.branchId,
        restaurantId: context.restaurantId,
      },
      select: { id: true },
    })

    if (!writeBranch) {
      return new NextResponse('Station not found for this account.', { status: 400 })
    }

    const writeBranchId = writeBranch.id

    const amount = parseAmount(body.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      return new NextResponse('Invalid amount', { status: 400 })
    }

    // Apply discount before recording
    const discountPct = Number(body.discount ?? 0)
    const effectiveAmount = discountPct > 0 && discountPct < 100
      ? Math.round(amount * (1 - discountPct / 100) * 100) / 100
      : amount

    const rawDirection = body.direction
    const direction: 'in' | 'out' | 'opening' =
      rawDirection === 'opening' ? 'opening' : rawDirection === 'in' ? 'in' : 'out'
    const categoryType =
      direction === 'opening' ? 'equity'
      : body.categoryType && typeof body.categoryType === 'string'
        ? (body.categoryType as string)
        : direction === 'out' ? 'expense' : 'income'

    const baseDescription = String(body.description || 'Manual entry')
    const clientName = typeof body.clientName === 'string' ? body.clientName.trim() : ''
    const description = clientName ? `${baseDescription} — ${clientName}` : baseDescription

    const date = parseDateOrNow(body.date)
    const paymentMethod = body.paymentMethod || 'Cash'
    const vatEnabled = Boolean(body.vatEnabled)

    // Opening balance: DR asset, CR Opening Balance (equity)
    if (direction === 'opening') {
      await recordJournalEntry(prisma, {
        restaurantId: context.restaurantId,
        branchId: writeBranchId,
        date,
        description: description || 'Opening Balance',
        reference: 'manual',
        amount: effectiveAmount,
        direction: 'in',
        accountName: 'Opening Balance',
        categoryType: 'equity',
        paymentMethod,
      })
      return NextResponse.json({ ok: true })
    }

    // Income with VAT: 3-line entry
    if (vatEnabled && direction === 'in') {
      await recordVatJournalEntry(prisma, {
        restaurantId: context.restaurantId,
        branchId: writeBranchId,
        date,
        description,
        reference: 'manual',
        netAmount: effectiveAmount,
        paymentMethod,
        accountName: body.accountName ? String(body.accountName) : undefined,
      })
      return NextResponse.json({ ok: true })
    }

    // Standard 2-line entry
    await recordJournalEntry(prisma, {
      restaurantId: context.restaurantId,
      branchId: writeBranchId,
      date,
      description,
      reference: 'manual',
      amount: effectiveAmount,
      direction,
      accountName: body.accountName ? String(body.accountName) : undefined,
      categoryType,
      paymentMethod,
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return new NextResponse('Unauthorized', { status: 401 })
    }

    if (isPrismaDatabaseUnavailableError(error)) {
      logDatabaseUnavailable('api/transactions POST', error)
      return databaseUnavailableJson({
        message: 'Transaction changes could not be saved because the database connection is down.',
      })
    }

    console.error('Error saving transaction:', error)
    const message = error instanceof Error ? error.message : 'Error'
    return new NextResponse(message, { status: 500 })
  }
}
