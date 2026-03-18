import { NextResponse } from 'next/server'
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

async function reprocessUpload(uploadId: string, userId: string) {
	const upload = await prisma.upload.findUnique({
		where: { id: uploadId }
	})

	if (!upload || upload.userId !== userId) {
		throw new Error('Upload not found or unauthorized')
	}

	await prisma.upload.update({
		where: { id: uploadId },
		data: { status: 'processing', errorMessage: null }
	})

	try {
		const filePath = path.join(process.cwd(), 'public', upload.filePath)
		const buffer = await readFile(filePath)
		const imageBase64 = buffer.toString('base64')

		const ext = path.extname(upload.filePath).toLowerCase()
		const mimeTypeMap: Record<string, string> = {
			'.png': 'image/png',
			'.jpg': 'image/jpeg',
			'.jpeg': 'image/jpeg',
			'.webp': 'image/webp',
			'.gif': 'image/gif'
		}
		const mimeType = mimeTypeMap[ext] || 'image/png'

		const dictionary = await prisma.customDictionary.findMany({
			orderBy: { createdAt: 'asc' }
		})

		const extracted = await extractFromImage({
			imageBase64,
			mimeType,
			dictionary
		})

		// Validate and filter transactions
		extracted.transactions = validateAndFilterTransactions(extracted.transactions)

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

		await prisma.transaction.deleteMany({
			where: { uploadId: upload.id }
		})

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
			return created
		})

		await prisma.upload.update({
			where: { id: upload.id },
			data: { status: 'completed' }
		})

		return createdTransactions
	} catch (error: any) {
		await prisma.upload.update({
			where: { id: uploadId },
			data: {
				status: 'failed',
				errorMessage: error.message || 'Reprocessing failed'
			}
		})
		throw error
	}
}

export async function POST(req: Request) {
	try {
		const userId = await requireUserId()

		// Get all dictionary words
		const dictionaryWords = await prisma.customDictionary.findMany({
			select: { kinyarwandaWord: true }
		})
		const resolvedWords = new Set(dictionaryWords.map(d => d.kinyarwandaWord.toLowerCase()))

		// Find all unknown words that are now in dictionary
		const unknownWords = await prisma.unknownWord.findMany({
			where: {
				status: 'pending'
			},
			select: {
				uploadId: true,
				word: true
			}
		})

		// Group by upload and check if any words are now resolved
		const uploadIdsToReprocess = new Set<string>()
		for (const uw of unknownWords) {
			if (uw.uploadId && resolvedWords.has(uw.word.toLowerCase())) {
				uploadIdsToReprocess.add(uw.uploadId)
			}
		}

		if (uploadIdsToReprocess.size === 0) {
			return NextResponse.json({
				success: true,
				reprocessedCount: 0,
				message: 'No uploads with resolved words found'
			})
		}

		// Get the actual uploads
		const uploadsToReprocess = await prisma.upload.findMany({
			where: {
				userId,
				id: { in: Array.from(uploadIdsToReprocess) },
				status: { in: ['completed', 'failed'] }
			}
		})

		if (uploadsToReprocess.length === 0) {
			return NextResponse.json({
				success: true,
				reprocessedCount: 0,
				message: 'No uploads with resolved words found'
			})
		}

		// Reprocess each upload
		let successCount = 0
		let failCount = 0
		const results: any[] = []

		for (const upload of uploadsToReprocess) {
			try {
				const created = await reprocessUpload(upload.id, userId)
				successCount++
				results.push({
					uploadId: upload.id,
					fileName: upload.fileName,
					success: true,
					transactionsCreated: created
				})
			} catch (error: any) {
				failCount++
				results.push({
					uploadId: upload.id,
					fileName: upload.fileName,
					success: false,
					error: error.message
				})
			}
		}

		return NextResponse.json({
			success: true,
			reprocessedCount: successCount,
			failedCount: failCount,
			totalAttempted: uploadsToReprocess.length,
			results,
			message: `Reprocessed ${successCount} upload(s) successfully${failCount > 0 ? `, ${failCount} failed` : ''}`
		})
	} catch (error: any) {
		console.error('Error in auto-reprocess:', error)
		return new NextResponse(error.message || 'Failed to reprocess', { status: 500 })
	}
}
