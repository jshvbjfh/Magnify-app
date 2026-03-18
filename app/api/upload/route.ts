import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth/next'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { extractFromImage } from '@/lib/openai'
import { validateAndFilterTransactions } from '@/lib/validateTransaction'
import { mkdir, writeFile } from 'node:fs/promises'
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
	// Handle common formats like "10,000" or "RWF 10,000".
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

export async function POST(req: Request) {
	let uploadId: string | null = null
	let storedFilePath: string | null = null
	try {
		const userId = await requireUserId()
		const formData = await req.formData()
		const file = formData.get('file') as File | null
		if (!file) return new NextResponse('Missing file', { status: 400 })

		const buffer = Buffer.from(await file.arrayBuffer())
		const imageBase64 = buffer.toString('base64')

		const upload = await prisma.upload.create({
			data: {
				userId,
				fileName: file.name,
				filePath: '',
				status: 'processing',
				errorMessage: null
			}
		})
		uploadId = upload.id

		const uploadsDir = path.join(process.cwd(), 'public', 'uploads')
		await mkdir(uploadsDir, { recursive: true })
		const ext = path.extname(file.name) || '.png'
		const storedName = `${upload.id}${ext}`
		await writeFile(path.join(uploadsDir, storedName), buffer)
		storedFilePath = `/uploads/${storedName}`
		await prisma.upload.update({
			where: { id: upload.id },
			data: { filePath: storedFilePath }
		})

		const dictionary = await prisma.customDictionary.findMany({
			orderBy: { createdAt: 'asc' }
		})

		const extracted = await extractFromImage({
			imageBase64,
			mimeType: file.type,
			dictionary
		})

		// Debug: Log what AI extracted
		console.log('=== AI EXTRACTION DEBUG ===')
		console.log('Raw Text:', extracted.rawText)
		console.log('Translated:', extracted.translatedText)
		console.log('Unknown Words:', extracted.unknownWords)
		console.log('Transactions:', JSON.stringify(extracted.transactions, null, 2))
		console.log('=========================')

		// Validate and filter transactions
		extracted.transactions = validateAndFilterTransactions(extracted.transactions)

		// Check if there are unknown words - if yes, STOP and ask user
		if (extracted.unknownWords && extracted.unknownWords.length > 0) {
			// Save unknown words for user to clarify
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

			// Store extracted data and mark as pending clarification
			await prisma.upload.update({
				where: { id: upload.id },
				data: {
					status: 'pending_clarification',
					rawText: extracted.rawText,
					translatedText: extracted.translatedText,
					pendingData: JSON.stringify(extracted.transactions)
				}
			})

			return NextResponse.json({
				ok: true,
				uploadId: upload.id,
				status: 'pending_clarification',
				unknownWords: extracted.unknownWords,
				message: `Found ${extracted.unknownWords.length} unknown word(s). Please define them before transactions can be created.`
			})
		}

		// No unknown words - proceed with creating transactions
		const createdTransactions = await prisma.$transaction(async (tx) => {
			const categories = await ensureCoreCategories(tx)
			const cashAccount = await ensureAccount(tx, {
				name: 'Cash',
				type: 'asset',
				categoryId: categories.asset.id,
				code: '1000'
			})

			// Group transactions by summary to detect AR/AP pairs
			const grouped = new Map<string, typeof extracted.transactions>()
			for (const t of extracted.transactions) {
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

					// Special handling for non-cash transactions
					// 1. Accounts Receivable should pair with Sales Revenue (credit sale)
					// 2. Sales Revenue should pair with Accounts Receivable
					// 3. Cost of Goods Sold should pair with Inventory/Purchases
					// 4. Accounts Payable should pair with Expense accounts
					
					const isAccountsReceivable = mainAccountName === 'Accounts Receivable'
					const isSalesRevenue = mainAccountName === 'Sales Revenue' || mainAccountName === 'Service Revenue'
					const isCostOfGoods = mainAccountName === 'Cost of Goods Sold'
					const isAccountsPayable = mainAccountName === 'Accounts Payable'
					
					if (isAccountsReceivable && direction === 'in') {
						// Debit AR, Credit Sales Revenue (credit sale - customer owes us)
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
						// Debit AR, Credit Sales Revenue (same as above, just different extraction order)
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
						// Debit COGS, Credit Inventory (or Purchases if no inventory account)
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
						// Skip - AP should be paired with expense in the grouping logic above
						continue
					} else if (direction === 'out') {
						// Regular cash expense: Debit Expense, Credit Cash
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
						// Regular cash income: Debit Cash, Credit Revenue
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

			await tx.upload.update({
				where: { id: upload.id },
				data: {
					status: 'completed',
					rawText: extracted.rawText,
					translatedText: extracted.translatedText,
					errorMessage: null
				}
			})

			return created
		})

		return NextResponse.json({
			ok: true,
			uploadId: upload.id,
			status: 'completed',
			createdTransactions,
			unknownWords: [],
			message: `Successfully created ${createdTransactions} transactions.`
		})
	} catch (e: any) {
		const msg = e?.message || 'Upload failed'
		const status = msg === 'Unauthorized' ? 401 : 500

		// Avoid leaving uploads stuck in "processing".
		if (uploadId) {
			try {
				await prisma.upload.update({
					where: { id: uploadId },
					data: storedFilePath
						? { status: 'failed', filePath: storedFilePath, errorMessage: msg }
						: { status: 'failed', errorMessage: msg }
				})
			} catch {
				// ignore
			}
		}
		return new NextResponse(msg, { status })
	}
}
