import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { databaseUnavailableJson, isPrismaDatabaseUnavailableError, logDatabaseUnavailable } from '@/lib/apiDatabase'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { recordJournalEntry } from '@/lib/accounting'
import { getRestaurantContextForUser, isMainRestaurantBranch } from '@/lib/restaurantAccess'

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

async function requireUserId() {
	const session = await getServerSession(authOptions)
	const userId = session?.user?.id
	if (!userId) throw new UnauthorizedError()
	return userId
}

async function requireTransactionContext() {
	const userId = await requireUserId()
	const context = await getRestaurantContextForUser(userId)

	return {
		currentUserId: userId,
		billingUserId: context?.billingUserId ?? userId,
		restaurantId: context?.restaurantId ?? null,
		branchId: context?.branchId ?? null,
	}
}

async function buildTransactionScopeFilter(restaurantId: string | null, branchId: string | null) {
	if (!restaurantId) return {}
	if (!branchId) return { restaurantId, branchId: null }

	const includeBranchlessRows = await isMainRestaurantBranch(restaurantId, branchId)
	return {
		restaurantId,
		...(includeBranchlessRows
			? { OR: [{ branchId }, { branchId: null }] }
			: { branchId }),
	}
}

export async function GET(req: Request) {
	try {
		const context = await requireTransactionContext()
		const { searchParams } = new URL(req.url)
		const startDate = searchParams.get('startDate')
		const endDate = searchParams.get('endDate')
		const dateFilter = startDate && endDate
			? {
				date: {
					gte: new Date(`${startDate}T00:00:00`),
					lte: new Date(`${endDate}T23:59:59.999`)
				}
			}
			: {}
		const transactions = await prisma.transaction.findMany({
			where: {
				userId: context.billingUserId,
				...(await buildTransactionScopeFilter(context.restaurantId, context.branchId)),
				...dateFilter,
			},
			orderBy: { date: 'desc' },
			include: {
				account: true,
				category: true,
				upload: true
			}
		})

		return NextResponse.json({
			transactions: transactions.map((t) => ({
				id: t.id,
				date: t.date.toISOString(),
				description: t.description,
				amount: t.amount,
				type: t.type,
				accountName: t.accountName || t.account.name,
				categoryType: t.category.type,
				paymentMethod: t.paymentMethod,
				pairId: t.pairId,
				isManual: t.isManual,
				sourceKind: t.sourceKind,
				uploadId: t.uploadId,
				screenshotUrl: t.upload?.filePath || null
			}))
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
		const context = await requireTransactionContext()
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
			userId: context.billingUserId,
			restaurantId: context.restaurantId,
			branchId: context.branchId,
			date,
			description,
			amount,
			direction,
			accountName: body.accountName ? String(body.accountName) : undefined,
			categoryType,
			paymentMethod,
			isManual: true,
			sourceKind: 'manual_entry',
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

		const message = error instanceof Error ? error.message : 'Error'
		console.error('Error saving transaction:', error)
		return new NextResponse(message, { status: 500 })
	}
}
