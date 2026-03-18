import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import type { Prisma, PrismaClient } from '@prisma/client'

async function requireUserId() {
	const session = await getServerSession(authOptions)
	const userId = session?.user?.id
	if (!userId) throw new Error('Unauthorized')
	return userId
}

type DbClient = PrismaClient | Prisma.TransactionClient

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

async function ensureCoreCategories(db: DbClient) {
	const types = ['income', 'expense', 'asset', 'liability', 'equity'] as const
	const byType: Record<string, { id: string; type: string; name: string }> = {}
	for (const t of types) {
		const name = t.charAt(0).toUpperCase() + t.slice(1)
		const cat = await db.category.upsert({
			where: { restaurantId_name: { restaurantId: null, name } },
			update: { type: t },
			create: { restaurantId: null, name, type: t }
		})
		byType[t] = cat
	}
	return byType
}

async function ensureAccount(
	db: DbClient,
	params: { name: string; type: string; categoryId: string; code?: string }
) {
	const existing = await db.account.findFirst({ where: { name: params.name } })
	if (existing) return existing

	const code =
		params.code ||
		`AUTO-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase()

	return db.account.create({
		data: {
			code,
			name: params.name,
			type: params.type,
			categoryId: params.categoryId
		}
	})
}

// Finalize upload and create transactions after all words are defined
export async function POST(
	request: Request,
	{ params }: { params: Promise<{ id: string }> }
) {
	try {
		const userId = await requireUserId()
		const uploadId = (await params).id

		const upload = await prisma.upload.findUnique({
			where: { id: uploadId }
		})

		if (!upload || upload.userId !== userId) {
			return NextResponse.json({ error: 'Upload not found or unauthorized' }, { status: 404 })
		}

		if (upload.status !== 'pending_clarification') {
			return NextResponse.json({ 
				error: `Upload cannot be finalized. Current status: ${upload.status}` 
			}, { status: 400 })
		}

		if (!upload.pendingData) {
			return NextResponse.json({ 
				error: 'No pending transaction data found' 
			}, { status: 400 })
		}

		// Check if all unknown words for this upload are resolved
		const unresolvedWords = await prisma.unknownWord.findMany({
			where: {
				uploadId,
				status: 'pending'
			}
		})

		if (unresolvedWords.length > 0) {
			return NextResponse.json({ 
				error: `Still ${unresolvedWords.length} unknown word(s) pending clarification`,
				unresolvedWords: unresolvedWords.map(w => w.word)
			}, { status: 400 })
		}

		// Parse pending transactions
		const transactions = JSON.parse(upload.pendingData)

		// Create transactions from pending data
		const createdTransactions = await prisma.$transaction(async (tx) => {
			const categories = await ensureCoreCategories(tx)
			const cashAccount = await ensureAccount(tx, {
				name: 'Cash',
				type: 'asset',
				categoryId: categories.asset.id,
				code: '1000'
			})

			// Group transactions by summary to detect AR/AP pairs
			const grouped = new Map<string, typeof transactions>()
			for (const t of transactions) {
				const key = (t as any).summary || 'default'
				if (!grouped.has(key)) grouped.set(key, [])
				grouped.get(key)!.push(t)
			}

			let created = 0
			for (const [summary, group] of grouped) {
				// Check if this is an AR/AP pair (2 transactions with same summary)
				if (group.length === 2) {
					const t1 = group[0]
					const t2 = group[1]
					const amount1 = parseAmount((t1 as any).amount)
					const amount2 = parseAmount((t2 as any).amount)
					
					// Must be same amount
					if (amount1 === amount2 && Number.isFinite(amount1) && amount1 > 0) {
						const acct1Name = t1.accountName || ''
						const acct2Name = t2.accountName || ''
						
						// Detect AR payment: Cash (in) + Accounts Receivable (out)
						const isCashARPayment = 
							(acct1Name === 'Cash' && t1.direction === 'in' && acct2Name === 'Accounts Receivable' && t2.direction === 'out') ||
							(acct2Name === 'Cash' && t2.direction === 'in' && acct1Name === 'Accounts Receivable' && t1.direction === 'out')
						
						if (isCashARPayment) {
							const arAccount = await ensureAccount(tx, {
								name: 'Accounts Receivable',
								type: 'asset',
								categoryId: categories.asset.id
							})
							const date = parseDateOrNow((t1 as any).date || (t2 as any).date)
							const description = t1.description || t2.description || 'AR payment received'
							const pairId = `pair-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
							
							// Correct entry: Debit Cash, Credit AR
							await tx.transaction.createMany({
								data: [
									{
										userId,
										uploadId: upload.id,
										accountId: cashAccount.id,
										categoryId: cashAccount.categoryId,
										date,
										description,
										amount: amount1,
										type: 'debit',
										isManual: false,
										paymentMethod: 'Cash',
										pairId
									},
									{
										userId,
										uploadId: upload.id,
										accountId: arAccount.id,
										categoryId: arAccount.categoryId,
										date,
										description,
										amount: amount1,
										type: 'credit',
										isManual: false,
										paymentMethod: 'Cash',
										pairId
									}
								]
							})
							created += 2
							continue
						}
					}
				}
				
				// Process each transaction individually if not a special pair
				for (const t of group) {
					const amount = parseAmount((t as any).amount)
					if (!Number.isFinite(amount) || amount <= 0) continue

					const direction = t.direction === 'in' ? 'in' : 'out'
					const categoryType = t.categoryType || (direction === 'out' ? 'expense' : 'income')
					const mainCategory = categories[categoryType] || categories.expense
					const mainAccountType =
						mainCategory.type === 'income'
							? 'revenue'
							: mainCategory.type === 'expense'
								? 'expense'
								: mainCategory.type
					const mainAccountName =
						t.accountName || (mainCategory.type === 'income' ? 'Sales' : 'General Expense')
					
					// Skip if this is Cash in a pair we already handled
					if (mainAccountName === 'Cash') continue
					
					const mainAccount = await ensureAccount(tx, {
						name: mainAccountName,
						type: mainAccountType,
						categoryId: mainCategory.id
					})

					const date = parseDateOrNow((t as any).date)
					const description = t.description || 'Extracted transaction'
					const pairId = `pair-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`

					// Cash by default: always create balancing entry.
					if (direction === 'out') {
						await tx.transaction.createMany({
							data: [
								{
									userId,
									uploadId: upload.id,
									accountId: mainAccount.id,
									categoryId: mainAccount.categoryId,
									date,
									description,
									amount,
									type: 'debit',
									isManual: false,
									paymentMethod: 'Cash',
									pairId
								},
								{
									userId,
									uploadId: upload.id,
									accountId: cashAccount.id,
									categoryId: cashAccount.categoryId,
									date,
									description,
									amount,
									type: 'credit',
									isManual: false,
									paymentMethod: 'Cash',
									pairId
								}
							]
						})
						created += 2
					} else {
						await tx.transaction.createMany({
							data: [
								{
									userId,
									uploadId: upload.id,
									accountId: cashAccount.id,
									categoryId: cashAccount.categoryId,
									date,
									description,
									amount,
									type: 'debit',
									isManual: false,
									paymentMethod: 'Cash',
									pairId
								},
								{
									userId,
									uploadId: upload.id,
									accountId: mainAccount.id,
									categoryId: mainAccount.categoryId,
									date,
									description,
									amount,
									type: 'credit',
									isManual: false,
									paymentMethod: 'Cash',
									pairId
								}
							]
						})
						created += 2
					}
			}
		}

		// Update upload status to completed and clear pending data
		await tx.upload.update({
			where: { id: upload.id },
			data: {
				status: 'completed',
				pendingData: null
			}
		})

		return created
	})

	return NextResponse.json({
		success: true,
		uploadId: upload.id,
		createdTransactions,
		message: `Successfully created ${createdTransactions} transactions.`
	})
	} catch (error: any) {
		console.error('Error finalizing upload:', error)
		return NextResponse.json(
			{ error: error.message || 'Failed to finalize upload' },
			{ status: 500 }
		)
	}
}
