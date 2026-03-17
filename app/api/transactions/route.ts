import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

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
	if (!userId) throw new Error('Unauthorized')
	return userId
}

async function ensureCoreCategories() {
	const types = ['income', 'expense', 'asset', 'liability', 'equity'] as const
	const byType: Record<string, { id: string; type: string; name: string }> = {}
	for (const t of types) {
		const name = t.charAt(0).toUpperCase() + t.slice(1)
		const cat = await prisma.category.upsert({
			where: { name },
			update: { type: t },
			create: { name, type: t }
		})
		byType[t] = cat
	}
	return byType
}

async function ensureAccount(params: { name: string; type: string; categoryId: string; code?: string }) {
	const existing = await prisma.account.findFirst({ where: { name: params.name } })
	if (existing) return existing

	const code =
		params.code ||
		`AUTO-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase()

	return prisma.account.create({
		data: {
			code,
			name: params.name,
			type: params.type,
			categoryId: params.categoryId
		}
	})
}

export async function GET() {
	try {
		const userId = await requireUserId()
		const transactions = await prisma.transaction.findMany({
			where: { userId },
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
				accountName: t.account.name,
				categoryType: t.category.type,
				paymentMethod: t.paymentMethod,
				pairId: t.pairId,
				uploadId: t.uploadId,
				screenshotUrl: t.upload?.filePath || null
			}))
		})
	} catch (e: any) {
		return new NextResponse(e?.message || 'Unauthorized', { status: 401 })
	}
}

export async function POST(req: Request) {
	try {
		const userId = await requireUserId()
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
		const pairId = `pair-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`

		const categories = await ensureCoreCategories()
		const cashAccount = await ensureAccount({
			name: 'Cash',
			type: 'asset',
			categoryId: categories.asset.id,
			code: '1000'
		})

		const mainCategory = categories[categoryType] || categories.expense
		const mainAccountType =
			mainCategory.type === 'income'
				? 'revenue'
				: mainCategory.type === 'expense'
					? 'expense'
					: mainCategory.type
		const mainAccountName = body.accountName ? String(body.accountName) : mainCategory.type === 'income' ? 'Sales' : 'General Expense'
		const mainAccount = await ensureAccount({
			name: mainAccountName,
			type: mainAccountType,
			categoryId: mainCategory.id
		})

		// Cash by default: every entry creates two journal lines.
		if (direction === 'out') {
			await prisma.transaction.createMany({
				data: [
					{
						userId,
						accountId: mainAccount.id,
						categoryId: mainAccount.categoryId,
						date,
						description,
						amount,
						type: 'debit',
						isManual: true,
						paymentMethod,
						pairId
					},
					{
						userId,
						accountId: cashAccount.id,
						categoryId: cashAccount.categoryId,
						date,
						description,
						amount,
						type: 'credit',
						isManual: true,
						paymentMethod,
						pairId
					}
				]
			})
		} else {
			await prisma.transaction.createMany({
				data: [
					{
						userId,
						accountId: cashAccount.id,
						categoryId: cashAccount.categoryId,
						date,
						description,
						amount,
						type: 'debit',
						isManual: true,
						paymentMethod,
						pairId
					},
					{
						userId,
						accountId: mainAccount.id,
						categoryId: mainAccount.categoryId,
						date,
						description,
						amount,
						type: 'credit',
						isManual: true,
						paymentMethod,
						pairId
					}
				]
			})
		}

		return NextResponse.json({ ok: true })
	} catch (e: any) {
		const msg = e?.message || 'Error'
		const status = msg === 'Unauthorized' ? 401 : 500
		return new NextResponse(msg, { status })
	}
}
