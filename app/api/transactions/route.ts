import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { databaseUnavailableJson, isPrismaDatabaseUnavailableError, logDatabaseUnavailable } from '@/lib/apiDatabase'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { recordJournalEntry } from '@/lib/accounting'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'

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
  const d = new Date(String(raw))
  return Number.isFinite(d.getTime()) ? d : new Date()
}

async function requireContext() {
  const session = await getServerSession(authOptions)
  const userId = session?.user?.id
  if (!userId) throw new UnauthorizedError()
  const context = await getRestaurantContextForUser(userId)
  return {
    userId,
    restaurantId: context?.restaurantId ?? null,
    branchId: context?.branchId ?? null,
  }
}

export async function GET(req: Request) {
  try {
    const context = await requireContext()

    if (!context.restaurantId || !context.branchId) {
      return new NextResponse('No restaurant branch linked to this account. Contact your administrator.', { status: 400 })
    }

    const { searchParams } = new URL(req.url)
    const startDate = searchParams.get('startDate')
    const endDate = searchParams.get('endDate')
    const dateFilter = startDate && endDate
      ? {
          entryDate: {
            gte: new Date(`${startDate}T00:00:00+02:00`),
            lte: new Date(`${endDate}T23:59:59.999+02:00`),
          },
        }
      : {}

    const entries = await prisma.journalEntry.findMany({
      where: {
        restaurantId: context.restaurantId,
        branchId: context.branchId,
        ...dateFilter,
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
        const mainAccount = isIncome ? (crLine?.account ?? null) : (drLine?.account ?? null)
        // Settlement account holds the cash/bank/asset side used for payment method detection
        const settlementAccount = isIncome ? (drLine?.account ?? null) : (crLine?.account ?? null)
        return {
          id: entry.id,
          date: entry.entryDate.toISOString(),
          createdAt: entry.createdAt.toISOString(),
          description: entry.description,
          amount,
          direction: isIncome ? 'in' : 'out',
          accountName: mainAccount?.name ?? '',
          categoryType: mainAccount?.category?.type ?? 'expense',
          paymentMethod: settlementAccount?.name ?? null,
          reference: entry.reference ?? null,
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
      return new NextResponse('No restaurant branch found for this write operation', { status: 400 })
    }

    const body = await req.json()

    const amount = parseAmount(body.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      return new NextResponse('Invalid amount', { status: 400 })
    }

    const direction = body.direction === 'in' ? 'in' : 'out'
    const categoryType =
      body.categoryType && typeof body.categoryType === 'string'
        ? (body.categoryType as string)
        : direction === 'out'
          ? 'expense'
          : 'income'
    const description = String(body.description || 'Manual entry')
    const date = parseDateOrNow(body.date)
    const paymentMethod = body.paymentMethod || 'Cash'

    await recordJournalEntry(prisma, {
      restaurantId: context.restaurantId,
      branchId: context.branchId,
      date,
      description,
      amount,
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
