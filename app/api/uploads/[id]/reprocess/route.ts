import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { extractFromImage } from '@/lib/openai'
import { validateAndFilterTransactions } from '@/lib/validateTransaction'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
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
			where: { name },
			update: { type: t },
			create: { name, type: t }
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

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
	try {
		const userId = await requireUserId()
		const uploadId = params.id

		// Find the upload
		const upload = await prisma.upload.findUnique({
			where: { id: uploadId }
		})

		if (!upload) {
			return new NextResponse('Upload not found', { status: 404 })
		}

		if (upload.userId !== userId) {
			return new NextResponse('Unauthorized', { status: 403 })
		}

		// Update status to processing
		await prisma.upload.update({
			where: { id: uploadId },
			data: { status: 'processing', errorMessage: null }
		})

		// Read the stored image file
		const filePath = path.join(process.cwd(), 'public', upload.filePath)
		const buffer = await readFile(filePath)
		const imageBase64 = buffer.toString('base64')

		// Determine mime type from file extension
		const ext = path.extname(upload.filePath).toLowerCase()
		const mimeTypeMap: Record<string, string> = {
			'.png': 'image/png',
			'.jpg': 'image/jpeg',
			'.jpeg': 'image/jpeg',
			'.webp': 'image/webp',
			'.gif': 'image/gif'
		}
		const mimeType = mimeTypeMap[ext] || 'image/png'

		// Get updated dictionary
		const dictionary = await prisma.customDictionary.findMany({
			orderBy: { createdAt: 'asc' }
		})

		// Extract with updated dictionary
		const extracted = await extractFromImage({
			imageBase64,
			mimeType,
			dictionary
		})

		// Validate and filter transactions
		extracted.transactions = validateAndFilterTransactions(extracted.transactions)

		// Update unknown words
		if (extracted.unknownWords && extracted.unknownWords.length > 0) {
			for (const word of extracted.unknownWords) {
				await prisma.unknownWord.upsert({
					where: {
						uploadId_word: {
							uploadId: upload.id,
							word: word
						}
					},
					update: {},
					create: {
						uploadId: upload.id,
						word,
						context: extracted.rawText || null,
						aiQuestion: `What does "${word}" mean in this context?`,
						status: 'pending'
					}
				})
			}
		}

		// Delete old transactions for this upload
		await prisma.transaction.deleteMany({
			where: { uploadId: upload.id }
		})

		// Create new transactions
		const createdTransactions = await prisma.$transaction(async (tx) => {
			const categories = await ensureCoreCategories(tx)
			const cashAccount = await ensureAccount(tx, {
				name: 'Cash',
				type: 'asset',
				categoryId: categories.asset.id,
				code: '1000'
			})

			let created = 0
			for (const t of extracted.transactions) {
				const amount = parseAmount((t as any).amount)
				if (!Number.isFinite(amount) || amount <= 0) continue

				// Validate and default direction
				const direction = t.direction === 'in' ? 'in' : (t.direction === 'out' ? 'out' : 'out')
				
				// Determine category type
				const categoryType = t.categoryType || (direction === 'out' ? 'expense' : 'income')
				const mainCategory = categories[categoryType] || categories.expense
				
				// Determine account type for main account
				const mainAccountType =
					mainCategory.type === 'income'
						? 'revenue'
						: mainCategory.type === 'expense'
							? 'expense'
							: mainCategory.type
				
				// Get account name - with better fallbacks
				let mainAccountName = t.accountName
				
				// If no account name provided, infer from category and direction
				if (!mainAccountName || mainAccountName.trim() === '') {
					if (categoryType === 'income') {
						mainAccountName = 'Sales Revenue'
					} else if (categoryType === 'expense') {
						// Try to infer from description
						const desc = (t.description || '').toLowerCase()
						if (desc.includes('cost') && (desc.includes('goods') || desc.includes('inventory') || desc.includes('sold'))) {
							mainAccountName = 'Cost of Goods Sold'
						} else if (desc.includes('fuel') || desc.includes('diesel') || desc.includes('petrol')) {
							mainAccountName = 'Fuel Expense'
						} else if (desc.includes('salary') || desc.includes('wage') || desc.includes('pay')) {
							mainAccountName = 'Salary Expense'
						} else if (desc.includes('transport')) {
							mainAccountName = 'Transport Expense'
						} else {
							mainAccountName = 'General Expense'
						}
					} else if (categoryType === 'asset') {
						mainAccountName = 'Accounts Receivable'
					} else if (categoryType === 'liability') {
						mainAccountName = 'Accounts Payable'
					} else {
						mainAccountName = direction === 'out' ? 'General Expense' : 'Sales Revenue'
					}
				}
				
				const mainAccount = await ensureAccount(tx, {
					name: mainAccountName,
					type: mainAccountType,
					categoryId: mainCategory.id
				})

				const date = parseDateOrNow((t as any).date)
				const description = t.description || 'Extracted transaction'
				const pairId = `pair-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`

				// Special handling for non-cash transactions
				const isAccountsReceivable = mainAccountName === 'Accounts Receivable'
				const isSalesRevenue = mainAccountName === 'Sales Revenue' || mainAccountName === 'Service Revenue'
				const isCostOfGoods = mainAccountName === 'Cost of Goods Sold'
				const isAccountsPayable = mainAccountName === 'Accounts Payable'
				
				if (isAccountsReceivable && direction === 'in') {
					// Debit AR, Credit Sales Revenue
					const salesAccount = await ensureAccount(tx, {
						name: 'Sales Revenue',
						type: 'revenue',
						categoryId: categories.income.id
					})
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
								paymentMethod: 'Credit',
								pairId
							},
							{
								userId,
								uploadId: upload.id,
								accountId: salesAccount.id,
								categoryId: salesAccount.categoryId,
								date,
								description,
								amount,
								type: 'credit',
								isManual: false,
								paymentMethod: 'Credit',
								pairId
							}
						]
					})
					created += 2
				} else if (isSalesRevenue && direction === 'in') {
					// Debit AR, Credit Sales Revenue
					const arAccount = await ensureAccount(tx, {
						name: 'Accounts Receivable',
						type: 'asset',
						categoryId: categories.asset.id
					})
					await tx.transaction.createMany({
						data: [
							{
								userId,
								uploadId: upload.id,
								accountId: arAccount.id,
								categoryId: arAccount.categoryId,
								date,
								description,
								amount,
								type: 'debit',
								isManual: false,
								paymentMethod: 'Credit',
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
								paymentMethod: 'Credit',
								pairId
							}
						]
					})
					created += 2
				} else if (isCostOfGoods && direction === 'out') {
					// Debit COGS, Credit Inventory
					const inventoryAccount = await ensureAccount(tx, {
						name: 'Inventory',
						type: 'asset',
						categoryId: categories.asset.id
					})
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
								paymentMethod: 'Credit',
								pairId
							},
							{
								userId,
								uploadId: upload.id,
								accountId: inventoryAccount.id,
								categoryId: inventoryAccount.categoryId,
								date,
								description,
								amount,
								type: 'credit',
								isManual: false,
								paymentMethod: 'Credit',
								pairId
							}
						]
					})
					created += 2
				} else if (isAccountsPayable) {
					continue
				} else if (direction === 'out') {
					// Regular cash expense
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
					// Regular cash income
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
			return created
		})

		// Update upload status to completed
		await prisma.upload.update({
			where: { id: upload.id },
			data: { status: 'completed' }
		})

		return NextResponse.json({
			success: true,
			createdTransactions,
			message: `Reprocessed successfully. Created ${createdTransactions} transaction entries.`
		})
	} catch (error: any) {
		console.error('Error reprocessing upload:', error)
		
		// Update upload status to failed
		if (params.id) {
			try {
				await prisma.upload.update({
					where: { id: params.id },
					data: {
						status: 'failed',
						errorMessage: error.message || 'Reprocessing failed'
					}
				})
			} catch {}
		}

		return new NextResponse(error.message || 'Failed to reprocess', { status: 500 })
	}
}
