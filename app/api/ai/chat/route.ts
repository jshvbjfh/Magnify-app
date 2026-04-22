import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { AI_ANALYTICS_ENABLED } from '@/lib/aiAnalyticsFeature'
import { prisma } from '@/lib/prisma'
import { clearGeminiQuotaFailure, getGeminiAttemptPlan, getGeminiApiKeys, getGeminiKeyAvailability, getGeminiRetryConfig, getGeminiUnavailableMessage, isQuotaError, isRetryableGeminiServiceError, markGeminiQuotaFailure } from '@/lib/openai'
import { generateInventoryBatchId } from '@/lib/inventoryBatch'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

async function delay(ms: number) {
	if (ms <= 0) return
	await new Promise((resolve) => setTimeout(resolve, ms))
}

function sanitizeProviderMentions(text: string): string {
	return text
		.replace(/\bGemini\b/gi, 'Magnify')
		.replace(/\bGoogle\s*AI\b/gi, 'Magnify')
		.replace(/\bGoogle\s+Generative\s+AI\b/gi, 'Magnify')
		.replace(/\bgemini-[a-z0-9.-]+\b/gi, 'Magnify model')
}

function extractAllJsonBlocks(text: string): any[] {
	const results: any[] = []
	// Try markdown code fences first: ```json ... ```
	const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/g
	let match
	while ((match = fenceRegex.exec(text)) !== null) {
		try {
			const parsed = JSON.parse(match[1].trim())
			if (parsed && typeof parsed === 'object') results.push(parsed)
		} catch { /* skip invalid */ }
	}
	if (results.length > 0) return results
	// Fallback: brace-matching to find raw JSON objects
	let depth = 0, start = -1
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '{') {
			if (depth === 0) start = i
			depth++
		} else if (text[i] === '}') {
			depth--
			if (depth === 0 && start !== -1) {
				try {
					const parsed = JSON.parse(text.slice(start, i + 1))
					if (parsed && typeof parsed === 'object') results.push(parsed)
				} catch { /* skip */ }
				start = -1
			}
		}
	}
	return results
}

function pickFirstDefined(...values: unknown[]) {
	for (const value of values) {
		if (value === undefined || value === null) continue
		if (typeof value === 'string' && !value.trim()) continue
		return value
	}

	return undefined
}

function toTrimmedString(value: unknown) {
	if (value === undefined || value === null) return undefined
	const normalized = String(value).trim()
	return normalized || undefined
}

function parseNumericValue(value: unknown) {
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : null
	}

	if (typeof value === 'string') {
		const cleaned = value.replace(/,/g, '').replace(/[^0-9.-]/g, '')
		if (!cleaned || cleaned === '-' || cleaned === '.' || cleaned === '-.') return null
		const parsed = Number(cleaned)
		return Number.isFinite(parsed) ? parsed : null
	}

	return null
}

function normalizeAiActionName(action: unknown) {
	const normalized = String(action || '').trim().toLowerCase().replace(/[\s-]+/g, '_')
	if (!normalized) return null

	if (normalized === 'delete' || normalized === 'delete_transaction') return 'delete_transaction'
	if (['create_transaction', 'create_transactions', 'record_transaction', 'record_transactions', 'transaction', 'journal_entry', 'journal_entries'].includes(normalized)) {
		return 'create_transaction'
	}
	if (['add_inventory', 'inventory_add', 'add_item', 'add_items', 'update_inventory'].includes(normalized)) return 'add_inventory'
	if (['record_sale', 'record_sales', 'sale', 'inventory_sale'].includes(normalized)) return 'record_sale'
	if (['record_purchase', 'record_purchases', 'purchase', 'inventory_purchase', 'purchase_existing'].includes(normalized)) return 'record_purchase'
	if (['add_and_purchase', 'add_purchase', 'purchase_new', 'record_new_purchase', 'new_inventory_purchase'].includes(normalized)) return 'add_and_purchase'

	return normalized
}

function normalizeAiItemEntry(raw: any) {
	if (typeof raw === 'string') {
		const name = toTrimmedString(raw)
		return name ? { name } : null
	}

	if (!raw || typeof raw !== 'object') return null

	const name = toTrimmedString(
		pickFirstDefined(
			raw.name,
			raw.itemName,
			raw.item_name,
			raw.productName,
			raw.product_name,
			raw.product,
			raw.item,
			raw.description,
		),
	)
	if (!name) return null

	const quantity = parseNumericValue(pickFirstDefined(raw.quantity, raw.qty, raw.qtyPurchased, raw.qty_purchased, raw.count))
	const unitPrice = parseNumericValue(
		pickFirstDefined(
			raw.unitPrice,
			raw.unit_price,
			raw.pricePerUnit,
			raw.price_per_unit,
			raw.unitCost,
			raw.unit_cost,
			raw.costPerUnit,
			raw.cost_per_unit,
			raw.cost,
			raw.price,
		),
	)
	const totalCost = parseNumericValue(
		pickFirstDefined(raw.totalCost, raw.total_cost, raw.totalPrice, raw.total_price, raw.amount, raw.total),
	)

	const normalizedItem: Record<string, any> = { name }
	const unit = toTrimmedString(pickFirstDefined(raw.unit, raw.units, raw.measurementUnit, raw.measurement_unit))
	const category = toTrimmedString(raw.category)
	const inventoryType = toTrimmedString(pickFirstDefined(raw.inventoryType, raw.inventory_type))
	const customerName = toTrimmedString(
		pickFirstDefined(raw.customerName, raw.customer_name, raw.customer, raw.clientName, raw.client_name, raw.client),
	)
	const supplier = toTrimmedString(
		pickFirstDefined(raw.supplier, raw.supplierName, raw.supplier_name, raw.vendor, raw.vendorName, raw.vendor_name),
	)
	const itemDate = pickFirstDefined(raw.date, raw.purchasedAt, raw.purchased_at, raw.transactionDate, raw.transaction_date)

	if (unit) normalizedItem.unit = unit
	if (quantity !== null) normalizedItem.quantity = quantity
	if (unitPrice !== null) normalizedItem.unitPrice = unitPrice
	if (totalCost !== null) normalizedItem.totalCost = totalCost
	if (category) normalizedItem.category = category
	if (inventoryType) normalizedItem.inventoryType = inventoryType
	if (customerName) normalizedItem.customerName = customerName
	if (supplier) normalizedItem.supplier = supplier
	if (itemDate !== undefined) normalizedItem.date = itemDate

	return normalizedItem
}

function normalizeAiTransactionEntry(raw: any) {
	if (!raw || typeof raw !== 'object') return null

	const amount = parseNumericValue(pickFirstDefined(raw.amount, raw.totalCost, raw.total_cost, raw.totalPrice, raw.total_price, raw.value))
	const description = toTrimmedString(pickFirstDefined(raw.description, raw.memo, raw.narration, raw.details))
	const type = toTrimmedString(pickFirstDefined(raw.type, raw.transactionType, raw.transaction_type, raw.entryType, raw.entry_type))
	const date = pickFirstDefined(raw.date, raw.transactionDate, raw.transaction_date)
	const debitAccount = toTrimmedString(pickFirstDefined(raw.debitAccount, raw.debit_account, raw.debit))
	const creditAccount = toTrimmedString(pickFirstDefined(raw.creditAccount, raw.credit_account, raw.credit))

	if (!amount || !description) return null

	const transaction: Record<string, any> = {
		amount,
		description,
	}
	if (type) transaction.type = type
	if (date !== undefined) transaction.date = date
	if (debitAccount) transaction.debitAccount = debitAccount
	if (creditAccount) transaction.creditAccount = creditAccount

	return transaction
}

function buildNormalizedAiBlockKey(block: any) {
	if (!block?.action) return null
	const groupable = Array.isArray(block.items) || Array.isArray(block.transactions)
	if (!groupable) return null

	return JSON.stringify({
		action: block.action,
		date: block.date ?? null,
		paymentMethod: block.paymentMethod ?? null,
		supplier: block.supplier ?? null,
		message: block.message ?? null,
		createItemizedEntries: block.createItemizedEntries ?? null,
	})
}

function groupNormalizedAiBlocks(blocks: any[]) {
	const grouped: any[] = []
	const indexByKey = new Map<string, number>()

	for (const block of blocks) {
		const key = buildNormalizedAiBlockKey(block)
		if (!key) {
			grouped.push(block)
			continue
		}

		const existingIndex = indexByKey.get(key)
		if (existingIndex === undefined) {
			grouped.push({
				...block,
				...(Array.isArray(block.items) ? { items: [...block.items] } : {}),
				...(Array.isArray(block.transactions) ? { transactions: [...block.transactions] } : {}),
			})
			indexByKey.set(key, grouped.length - 1)
			continue
		}

		const existing = grouped[existingIndex]
		if (Array.isArray(block.items)) {
			existing.items.push(...block.items)
		}
		if (Array.isArray(block.transactions)) {
			existing.transactions.push(...block.transactions)
		}
	}

	return grouped
}

function normalizeAiActionBlock(rawBlock: any): any | null {
	if (!rawBlock || typeof rawBlock !== 'object' || Array.isArray(rawBlock)) return null

	const action = normalizeAiActionName(
		pickFirstDefined(rawBlock.action, rawBlock.intent, rawBlock.operation, rawBlock.kind),
	)
	if (!action) return null

	const date = pickFirstDefined(rawBlock.date, rawBlock.purchasedAt, rawBlock.purchased_at, rawBlock.transactionDate, rawBlock.transaction_date)
	const paymentMethod = toTrimmedString(
		pickFirstDefined(rawBlock.paymentMethod, rawBlock.payment_method, rawBlock.payment, rawBlock.method),
	)
	const supplier = toTrimmedString(
		pickFirstDefined(rawBlock.supplier, rawBlock.supplierName, rawBlock.supplier_name, rawBlock.vendor, rawBlock.vendorName, rawBlock.vendor_name),
	)
	const message = toTrimmedString(pickFirstDefined(rawBlock.message, rawBlock.responseMessage, rawBlock.response_message))

	if (action === 'create_transaction') {
		const rawTransactions = Array.isArray(rawBlock.transactions)
			? rawBlock.transactions
			: Array.isArray(rawBlock.entries)
				? rawBlock.entries
				: Array.isArray(rawBlock.records)
					? rawBlock.records
					: [rawBlock]

		const transactions = rawTransactions
			.map((entry) => normalizeAiTransactionEntry(entry))
			.filter(Boolean)

		if (!transactions.length) return null

		return {
			action,
			transactions,
			...(message ? { message } : {}),
		}
	}

	const rawItems = Array.isArray(rawBlock.items)
		? rawBlock.items
		: Array.isArray(rawBlock.products)
			? rawBlock.products
			: Array.isArray(rawBlock.rows)
				? rawBlock.rows
				: rawBlock.item !== undefined || rawBlock.product !== undefined
					? [{
						...rawBlock,
						...(typeof rawBlock.item === 'object' && rawBlock.item !== null
							? rawBlock.item
							: typeof rawBlock.product === 'object' && rawBlock.product !== null
								? rawBlock.product
								: { name: rawBlock.item ?? rawBlock.product }),
					}]
					: [rawBlock]

	const items = rawItems
		.map((entry) => normalizeAiItemEntry(entry))
		.filter(Boolean)

	const normalizedBlock: Record<string, any> = {
		action,
		...(items.length ? { items } : {}),
		...(date !== undefined ? { date } : {}),
		...(paymentMethod ? { paymentMethod } : {}),
		...(supplier ? { supplier } : {}),
		...(message ? { message } : {}),
	}

	const createItemizedEntries = pickFirstDefined(rawBlock.createItemizedEntries, rawBlock.create_itemized_entries)
	if (createItemizedEntries !== undefined) {
		normalizedBlock.createItemizedEntries = createItemizedEntries === true || String(createItemizedEntries).toLowerCase() === 'true'
	}

	return normalizedBlock
}

function normalizeAiJsonBlocks(rawBlocks: any[]) {
	const expandedBlocks: any[] = []

	for (const rawBlock of rawBlocks) {
		if (Array.isArray(rawBlock)) {
			expandedBlocks.push(...normalizeAiJsonBlocks(rawBlock))
			continue
		}

		if (rawBlock && typeof rawBlock === 'object') {
			const wrapperEntries = Array.isArray(rawBlock.actions)
				? rawBlock.actions
				: Array.isArray(rawBlock.entries)
					? rawBlock.entries
					: Array.isArray(rawBlock.records)
						? rawBlock.records
						: null

			if (wrapperEntries) {
				const wrapperBase = { ...rawBlock }
				delete wrapperBase.actions
				delete wrapperBase.entries
				delete wrapperBase.records
				expandedBlocks.push(
					...normalizeAiJsonBlocks(
						wrapperEntries.map((entry: any) => entry && typeof entry === 'object' && !Array.isArray(entry)
							? { ...wrapperBase, ...entry }
							: entry,
						),
					),
				)
				continue
			}
		}

		const normalizedBlock = normalizeAiActionBlock(rawBlock)
		if (normalizedBlock) expandedBlocks.push(normalizedBlock)
	}

	return groupNormalizedAiBlocks(expandedBlocks)
}

function formatAiDiagnosticsNote(aiDiagnostics: any) {
	if (!aiDiagnostics) return ''

	const details = [`key #${aiDiagnostics.keyIndex}/${aiDiagnostics.keyCount}`, `model ${aiDiagnostics.modelName}`]
	if (aiDiagnostics.usedFallbackKey) details.push('fallback key')
	if (aiDiagnostics.usedFallbackModel) details.push('fallback model')

	return `[AI diagnostics: ${details.join(', ')}]`
}

function buildAiResponsePayload(payload: Record<string, any>, aiDiagnostics: any, showAiDiagnostics: boolean) {
	const nextPayload: Record<string, any> = { ...payload }
	if (aiDiagnostics) {
		nextPayload.aiDiagnostics = aiDiagnostics
		if (showAiDiagnostics && typeof nextPayload.response === 'string') {
			const note = formatAiDiagnosticsNote(aiDiagnostics)
			nextPayload.response = nextPayload.response ? `${nextPayload.response}\n\n${note}` : note
		}
	}

	return nextPayload
}

function normalizePaymentMethod(paymentMethod?: string): string {
	const raw = String(paymentMethod || 'Cash').trim().toLowerCase()
	if (raw.includes('note')) return 'Notes Payable'
	if (raw === 'credit' || raw.includes('accounts payable') || raw.includes('payable')) return 'Credit'
	if (raw.includes('mobile') || raw.includes('momo')) return raw.includes('owner') ? 'Owner Momo' : 'Mobile Money'
	if (raw.includes('bank') || raw.includes('transfer') || raw.includes('current account')) return 'Bank'
	return 'Cash'
}

function formatDateKey(date: Date) {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function shiftDate(base: Date, days: number) {
	const date = new Date(base)
	date.setDate(date.getDate() + days)
	return date
}

function parseExplicitDateFromMessage(message: string, now = new Date()): string | null {
	const text = String(message || '').trim()
	if (!text) return null
	const normalized = text.toLowerCase()

	if (/\btoday\b/.test(normalized)) return formatDateKey(now)
	if (/\byesterday\b/.test(normalized)) return formatDateKey(shiftDate(now, -1))
	if (/\btomorrow\b/.test(normalized)) return formatDateKey(shiftDate(now, 1))

	const daysAgoMatch = normalized.match(/\b(\d{1,3})\s+days?\s+ago\b/)
	if (daysAgoMatch) return formatDateKey(shiftDate(now, -Number(daysAgoMatch[1])))

	if (/\blast week\b/.test(normalized)) return formatDateKey(shiftDate(now, -7))
	if (/\blast month\b/.test(normalized)) {
		const lastMonth = new Date(now)
		lastMonth.setMonth(lastMonth.getMonth() - 1)
		return formatDateKey(lastMonth)
	}

	const isoMatch = normalized.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/)
	if (isoMatch) {
		return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`
	}

	const slashMatch = normalized.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](20\d{2})\b/)
	if (slashMatch) {
		const day = slashMatch[1].padStart(2, '0')
		const month = slashMatch[2].padStart(2, '0')
		return `${slashMatch[3]}-${month}-${day}`
	}

	const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
	const shortMonths = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec']
	const monthMap = new Map<string, number>()
	months.forEach((month, index) => monthMap.set(month, index + 1))
	shortMonths.forEach((month, index) => monthMap.set(month, index + 1))

	const dayMonthYearMatch = normalized.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(20\d{2}))?\b/)
	if (dayMonthYearMatch) {
		const month = monthMap.get(dayMonthYearMatch[2])
		if (month) return `${dayMonthYearMatch[3] || now.getFullYear()}-${String(month).padStart(2, '0')}-${dayMonthYearMatch[1].padStart(2, '0')}`
	}

	const monthDayYearMatch = normalized.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/)
	if (monthDayYearMatch) {
		const month = monthMap.get(monthDayYearMatch[1])
		if (month) return `${monthDayYearMatch[3] || now.getFullYear()}-${String(month).padStart(2, '0')}-${monthDayYearMatch[2].padStart(2, '0')}`
	}

	return null
}

function resolveActionDate(rawDate: unknown, message: string) {
	const explicitMessageDate = parseExplicitDateFromMessage(message)
	if (explicitMessageDate) return new Date(`${explicitMessageDate}T00:00:00`)
	if (rawDate) {
		const parsed = new Date(String(rawDate))
		if (Number.isFinite(parsed.getTime())) return parsed
	}
	return new Date()
}

function resolveInventoryEntryDate(rawActionDate: unknown, rawItemDate: unknown, message: string) {
	if (rawItemDate) {
		const parsed = new Date(String(rawItemDate))
		if (Number.isFinite(parsed.getTime())) return parsed
	}

	return resolveActionDate(rawActionDate, message)
}

function buildRestaurantReadScope(restaurantId: string | null, fieldName = 'restaurantId') {
	if (!restaurantId) {
		return { [fieldName]: null }
	}

	return {
		OR: [
			{ [fieldName]: restaurantId },
			{ [fieldName]: null },
		],
	}
}

function buildRestaurantWriteScope(restaurantId: string | null, fieldName = 'restaurantId') {
	return { [fieldName]: restaurantId ?? null }
}

async function ensureCategoryByType(type: string, fallbackName: string, restaurantId: string | null) {
	let category = await prisma.category.findFirst({
		where: {
			type,
			...buildRestaurantReadScope(restaurantId),
		},
	})
	if (!category) {
		category = await prisma.category.create({
			data: {
				...buildRestaurantWriteScope(restaurantId),
				name: fallbackName,
				type,
			} as any,
		})
	}
	return category
}

async function findScopedAccountByName(name: string, restaurantId: string | null) {
	return prisma.account.findFirst({
		where: {
			name,
			...buildRestaurantReadScope(restaurantId),
		},
	})
}

async function ensureNamedAccount(name: string, type: string, categoryId: string, codePrefix: string, restaurantId: string | null) {
	let account = await findScopedAccountByName(name, restaurantId)
	if (!account) {
		account = await prisma.account.create({
			data: {
				...buildRestaurantWriteScope(restaurantId),
				code: `${codePrefix}-${Date.now().toString(36).toUpperCase()}`,
				name,
				type,
				categoryId,
			},
		})
	}
	return account
}

async function findInventoryItemByName(userId: string, restaurantId: string | null, name: string) {
	const scope = buildRestaurantReadScope(restaurantId)
	return await prisma.inventoryItem.findFirst({
		where: { userId, name, ...scope }
	}) ?? await prisma.inventoryItem.findFirst({
		where: { userId, name: name.toLowerCase(), ...scope }
	}) ?? (await prisma.inventoryItem.findMany({
		where: { userId, ...scope }
	})).find((row: any) => row.name.toLowerCase() === name.toLowerCase()) ?? null
}

async function resolveSettlementAccount(paymentMethod: string | undefined, restaurantId: string | null) {
	const normalizedPaymentMethod = normalizePaymentMethod(paymentMethod)
	if (normalizedPaymentMethod === 'Credit') {
		const liabilityCategory = await ensureCategoryByType('liability', 'Liability', restaurantId)
		const account = await ensureNamedAccount('Accounts Payable', 'liability', liabilityCategory.id, 'LIB-AP', restaurantId)
		return { paymentMethod: normalizedPaymentMethod, account }
	}
	if (normalizedPaymentMethod === 'Notes Payable') {
		const liabilityCategory = await ensureCategoryByType('liability', 'Liability', restaurantId)
		const account = await ensureNamedAccount('Notes Payable', 'liability', liabilityCategory.id, 'LIB-NP', restaurantId)
		return { paymentMethod: normalizedPaymentMethod, account }
	}
	if (normalizedPaymentMethod === 'Bank') {
		const assetCategory = await ensureCategoryByType('asset', 'Asset', restaurantId)
		const account = await ensureNamedAccount('Current Account', 'asset', assetCategory.id, 'AST-BANK', restaurantId)
		return { paymentMethod: normalizedPaymentMethod, account }
	}
	if (normalizedPaymentMethod === 'Mobile Money') {
		const assetCategory = await ensureCategoryByType('asset', 'Asset', restaurantId)
		const account = await ensureNamedAccount('Mobile Money', 'asset', assetCategory.id, 'AST-MM', restaurantId)
		return { paymentMethod: normalizedPaymentMethod, account }
	}
	if (normalizedPaymentMethod === 'Owner Momo') {
		const assetCategory = await ensureCategoryByType('asset', 'Asset', restaurantId)
		const account = await ensureNamedAccount('Owner Momo', 'asset', assetCategory.id, 'AST-OMM', restaurantId)
		return { paymentMethod: normalizedPaymentMethod, account }
	}
	const assetCategory = await ensureCategoryByType('asset', 'Asset', restaurantId)
	const account = await ensureNamedAccount('Cash', 'asset', assetCategory.id, 'AST-CASH', restaurantId)
	return { paymentMethod: 'Cash', account }
}

async function createInventoryPurchaseBatch(params: {
	userId: string
	restaurantId?: string | null
	ingredientId: string
	quantity: number
	unitCost?: number | null
	totalCost?: number | null
	purchasedAt?: Date
	journalPairId?: string | null
	supplier?: string | null
}) {
	const quantity = Number(params.quantity || 0)
	const totalCost = Number(params.totalCost || 0)
	const explicitUnitCost = params.unitCost ?? null
	const resolvedUnitCost = explicitUnitCost !== null && Number.isFinite(explicitUnitCost)
		? explicitUnitCost
		: quantity > 0 && totalCost > 0
			? totalCost / quantity
			: null

	if (!(quantity > 0) || !(resolvedUnitCost !== null && resolvedUnitCost > 0)) {
		return null
	}

	return prisma.inventoryPurchase.create({
		data: {
			userId: params.userId,
			restaurantId: params.restaurantId ?? null,
			batchId: generateInventoryBatchId(params.purchasedAt || new Date()),
			journalPairId: params.journalPairId ?? null,
			ingredientId: params.ingredientId,
			supplier: params.supplier || 'AI Purchase',
			quantityPurchased: quantity,
			remainingQuantity: quantity,
			unitCost: resolvedUnitCost,
			totalCost: totalCost > 0 ? totalCost : quantity * resolvedUnitCost,
			purchasedAt: params.purchasedAt || new Date(),
		}
	})
}

async function createJournalPair(params: {
	userId: string
	restaurantId: string | null
	date: Date
	description: string
	amount: number
	paymentMethod: string
	debitAccountId: string
	debitCategoryId: string
	creditAccountId: string
	creditCategoryId: string
	sourceKind: string
	authoritativeForRevenue?: boolean
	pairId?: string
}) {
	const pairId = params.pairId || `pair-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
	const authoritativeForRevenue = params.authoritativeForRevenue ?? true

	await prisma.transaction.createMany({
		data: [
			{
				userId: params.userId,
				restaurantId: params.restaurantId,
				accountId: params.debitAccountId,
				categoryId: params.debitCategoryId,
				date: params.date,
				description: params.description,
				amount: params.amount,
				type: 'debit',
				isManual: true,
				paymentMethod: params.paymentMethod,
				pairId,
				sourceKind: params.sourceKind,
				authoritativeForRevenue,
			},
			{
				userId: params.userId,
				restaurantId: params.restaurantId,
				accountId: params.creditAccountId,
				categoryId: params.creditCategoryId,
				date: params.date,
				description: params.description,
				amount: params.amount,
				type: 'credit',
				isManual: true,
				paymentMethod: params.paymentMethod,
				pairId,
				sourceKind: params.sourceKind,
				authoritativeForRevenue,
			},
		],
	})

	return pairId
}

export async function POST(req: NextRequest) {
	let lastAiDiagnostics: any = null
	let showAiDiagnostics = process.env.NODE_ENV !== 'production'
	try {
		const session = await getServerSession(authOptions)
		if (!session?.user?.id) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}
		showAiDiagnostics = showAiDiagnostics || Boolean((session.user as any).isSuperAdmin)

		const body = await req.json()
		const { message, images, conversationHistory } = body
		const restaurantContext = await getRestaurantContextForUser(session.user.id)
		if (!restaurantContext) {
			return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
		}
		const restaurantId = restaurantContext.restaurantId
		const billingUserId = restaurantContext.billingUserId
		const restaurantReadScope = buildRestaurantReadScope(restaurantId)

		if (!message || typeof message !== 'string') {
			return NextResponse.json({ error: 'Message required' }, { status: 400 })
		}

		const apiKeys = getGeminiApiKeys()
		if (apiKeys.length === 0) {
			return NextResponse.json({ error: 'AI service not configured' }, { status: 500 })
		}
		const keyAvailability = getGeminiKeyAvailability(apiKeys)
		if (keyAvailability.availableKeyCount === 0) {
			console.warn(`[AI Chat] All ${apiKeys.length} keys blocked. Blocked: ${keyAvailability.blockedKeyCount}, cooldowns active.`)
			return NextResponse.json(buildAiResponsePayload({
				response: getGeminiUnavailableMessage('Jesse AI')
			}, lastAiDiagnostics, showAiDiagnostics), { status: 200 })
		}

		const recentTransactions = await prisma.transaction.findMany({
			where: { userId: billingUserId, ...restaurantReadScope },
			take: 50,
			orderBy: { date: 'desc' },
			select: {
				id: true,
				date: true,
				description: true,
				amount: true,
				type: true,
				account: {
					select: {
						name: true,
					}
				},
				category: {
					select: {
						type: true,
					}
				}
			}
		})

		const transactions = await prisma.transaction.findMany({
			where: { userId: billingUserId, ...restaurantReadScope },
			select: {
				amount: true,
				type: true,
				account: {
					select: {
						name: true,
					}
				},
				category: {
					select: {
						type: true,
					}
				}
			}
		})

		const balances: Record<string, number> = {}
		for (const tx of transactions) {
			const amount = tx.type === 'debit' ? tx.amount : -tx.amount
			const accountName = tx.account.name
			balances[accountName] = (balances[accountName] || 0) + amount
		}

		// Fetch inventory items for product sales
		const inventoryItems = await prisma.inventoryItem.findMany({
			where: { userId: billingUserId, ...restaurantReadScope },
			select: {
				id: true,
				name: true,
				unit: true,
				unitCost: true,
				quantity: true,
				category: true
			}
		})

		let latestSnapshotContext = ''
		if (AI_ANALYTICS_ENABLED) {
			const snapshotType = `ai_daily_insight_${session.user.id}`
			const latestSnapshotRow = await prisma.financialStatement.findFirst({
				where: { type: snapshotType },
				orderBy: { createdAt: 'desc' }
			})
			if (latestSnapshotRow) {
				try {
					const parsed = JSON.parse(latestSnapshotRow.data)
					latestSnapshotContext = `\n\nLATEST AI ANALYTICS SNAPSHOT (use this when the user asks about their analytics, performance, or strategy):\n${JSON.stringify({
						generatedAt: parsed.generatedAt,
						businessProfile: parsed.businessProfile,
						summary: parsed.summary,
						headline: parsed.ai?.headline,
						comments: parsed.ai?.comments || [],
						advice: parsed.ai?.advice || [],
						alerts: parsed.dataset?.spendingAlerts || []
					}, null, 2)}\n\nWhen user says "let's talk about my analytics", "what do you think of my numbers", "analyse my business", or similar: give a structured strategic breakdown using the RESPONSE STYLE format. Reference specific numbers from the snapshot above. Be direct, personal, and actionable.`
				} catch {
					latestSnapshotContext = ''
				}
			}
		}

		// Fetch dish sales for marketing context (last 30 days vs prior 30 days)
		const thirtyDaysAgo = new Date()
		thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
		const sixtyDaysAgo = new Date()
		sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60)

		const recentDishSales = await prisma.dishSale.findMany({
			where: { userId: billingUserId, saleDate: { gte: thirtyDaysAgo }, ...restaurantReadScope },
			include: { dish: true },
			orderBy: { saleDate: 'desc' }
		}).catch(() => [])

		const prevDishSales = await prisma.dishSale.findMany({
			where: { userId: billingUserId, saleDate: { gte: sixtyDaysAgo, lt: thirtyDaysAgo }, ...restaurantReadScope },
			include: { dish: true }
		}).catch(() => [])

		const dishRevMap: Record<string, { name: string; revenue: number; orders: number; cost: number }> = {}
		for (const s of recentDishSales) {
			if (!dishRevMap[s.dishId]) dishRevMap[s.dishId] = { name: s.dish.name, revenue: 0, orders: 0, cost: 0 }
			dishRevMap[s.dishId].revenue += Number(s.totalSaleAmount ?? 0)
			dishRevMap[s.dishId].orders += s.quantitySold
			dishRevMap[s.dishId].cost += Number(s.calculatedFoodCost ?? 0)
		}
		const prevRevMap: Record<string, number> = {}
		for (const s of prevDishSales) {
			prevRevMap[s.dishId] = (prevRevMap[s.dishId] || 0) + Number(s.totalSaleAmount ?? 0)
		}
		let recentTotalRevenue = 0
		for (const s of recentDishSales) recentTotalRevenue += Number(s.totalSaleAmount ?? 0)
		let prevTotalRevenue = 0
		for (const s of prevDishSales) prevTotalRevenue += Number(s.totalSaleAmount ?? 0)
		const revenueTrendPct = prevTotalRevenue > 0 ? ((recentTotalRevenue - prevTotalRevenue) / prevTotalRevenue * 100).toFixed(1) : null
		const dishPerformance = Object.entries(dishRevMap)
			.map(([id, d]) => ({
				name: d.name,
				revenue: d.revenue,
				orders: d.orders,
				margin: d.revenue > 0 ? (((d.revenue - d.cost) / d.revenue) * 100).toFixed(1) + '%' : 'N/A',
				vsPrev: prevRevMap[id] ? (((d.revenue - prevRevMap[id]) / prevRevMap[id]) * 100).toFixed(1) + '%' : 'new'
			}))
			.sort((a, b) => b.revenue - a.revenue)
			.slice(0, 10)

		let marketingDataContext = ''
		if (recentDishSales.length > 0 || prevDishSales.length > 0) {
			marketingDataContext = `\n\nRESTAURANT MARKETING DATA (last 30 days vs prior 30 days):
Overall Revenue Trend: ${revenueTrendPct !== null ? (parseFloat(revenueTrendPct) >= 0 ? '+' : '') + revenueTrendPct + '%' : 'No prior period data'}
Recent 30-day Revenue: ${recentTotalRevenue.toLocaleString()}
Prior 30-day Revenue: ${prevTotalRevenue.toLocaleString()}
Dish Performance (recent 30d):
${dishPerformance.map(d => `  - ${d.name}: ${d.revenue.toLocaleString()} revenue, ${d.orders} orders, ${d.margin} margin, vs prior: ${d.vsPrev}`).join('\n')}`
		}

const systemContext = `You are Jesse, a friendly and calm restaurant business advisor for Yofinder. You help managers with accounting, financial analysis, restaurant strategy, and growing their business. You speak simply and warmly — like a smart, trusted employee helping a friend, never like software interrogating a user.

🔒 IDENTITY RULE:
- Never mention underlying AI providers, model vendors, or model names.
- If asked what model/provider powers you, respond: "I am Magnify, your restaurant business assistant."

🎯 CORE BEHAVIOR - BE SMART & EFFICIENT:

⚡ RESPONSE FORMAT RULES - CRITICAL:
📋 Use PURE JSON (no text before/after) when:
   - Recording transactions ("record", "sold", "bought", "received", "paid")
   - Adding/updating inventory items ("add to inventory", user uploads inventory list image)
   - Recording inventory sales ("sold X kg/pieces/bunches of [item]")
   
💬 Use conversational text when:
   - Answering questions ("What's my balance?", "Show me inventory")
   - Asking for missing information ("What's the unit for bananas?")
   - Explaining concepts, giving analysis, or sharing business strategy

🎨 RESPONSE STYLE - ALWAYS follow this when giving advice, analysis, or strategy:
- Use SHORT, PUNCHY sentences — no long walls of text
- Add line breaks between distinct thoughts
- Use short bold headers (end them with a colon) before each section
- End strategy advice with ONE follow-up question to keep the conversation going — NEVER end with multiple questions
- Be warm, calm, and direct — like a smart mentor and trusted friend
- Reference the user's REAL data (their actual revenue, their best dishes, expenses) when available
- When giving numbered or bulleted lists, keep each item to ONE clear sentence
- EMPATHY FIRST: When a user shares a problem (slow sales, customer drop, losses), acknowledge their feelings BEFORE asking anything or giving advice. One sentence of empathy goes a long way.
- PLAIN LANGUAGE ALWAYS: Never say "The system is detecting…" or "Your analytics indicate…" — say it like a human: "I noticed…" or "It looks like…"

🔷 ICON SYNTAX — embed these in your text for visual clarity (NEVER use emoji 😊 — use only these icons):
::TrendingUp::     — revenue up, growth, something going in the right direction
::TrendingDown::   — decline, falling numbers, something getting worse
::CheckCircle::    — advantage, what the user has, positive factor
::XCircle::        — problem, what is missing, risk, or a bad sign
::AlertTriangle::  — warning, urgent issue, spending alert
::Lightbulb::      — idea, tip, insight, strategy suggestion
::Target::         — goal, focus area, what to aim for
::Flame::          — bestseller, high demand, hot item, strong performer
::Zap::            — quick win, fast action, immediate opportunity
::Users::          — staff, customers, team
::Clock::          — timing, slow hours, peak time, scheduling
::Banknote::       — money, revenue, profit, financial topic
::Star::           — best performer, top seller, excellent result
::ArrowRight::     — next step, recommendation, action to take
::ChefHat::        — kitchen, food prep, chef-related
::Award::          — achievement, milestone, something worth celebrating

Example of the style I want:
User asks: "How can I increase profit?"

Your profit has two levers.

Increase revenue:
::Flame:: Push your best-selling dishes proactively.
::TrendingUp:: Add a lunch combo — faster tables, more covers per day.
::Users:: Train staff to upsell sides and drinks.

Cut costs:
::AlertTriangle:: Review food waste — it silently kills margins.
::XCircle:: Drop any dish that has both low margin and low sales.
::Lightbulb:: Renegotiate with your top 3 suppliers.

What to do this week:
::ArrowRight:: Pull your top 5 dishes by margin.
::ArrowRight:: Remove anything costing more than it earns.
::ArrowRight:: Double down on what's already working.

What's your biggest expense right now?
Tell me and I'll show you exactly where the money is leaking.

🚨 HIGHEST PRIORITY WORKFLOW — EVIDENCE FIRST, IMAGE FIRST:

You are an accounting and inventory assistant that records business data from user messages and uploaded images.

Your job is not just to answer. Your job is to inspect the evidence, infer the user's intent, extract complete data when possible, and return the correct structured action without asking for information that is already visible.

IDENTITY AND ROLE:
- Help users record purchases, sales, inventory additions, and normal accounting transactions.
- When the user uploads an image, treat the image as a primary data source.
- Combine the current message, prior conversation history, prior uploaded images, and the current inventory list before deciding what to do.

CORE RULE:
- Never ask the user for data that is already visible in an uploaded image or already present in conversation history.
- If the user says "check the image", "it's in the form", "I already sent it", "record the new items", or "add the missing ones", re-read the existing image and act.
- Only ask a question if the required field is truly missing from both the image and the conversation context.

REQUIRED INTERNAL REASONING ORDER:
STEP 1: Identify intent
- "add to inventory", "put these in inventory", "inventory list" → inventory creation or update
- "I bought", "purchase", "stock in", "received goods", "purchase form" → inventory purchase recording
- "I sold", "customer bought", "sales form", "receipt", "invoice" → sale recording
- "record the new items", "record the missing ones", "add those items" after a partial failure → use the earlier image and prior failed-item context

STEP 2: Gather all context
- Read the current message
- Read conversation history
- Check whether an image was uploaded earlier in this same conversation
- Check prior assistant responses for failed item lists or missing item warnings
- Check the current inventory list for existing items, units, and known prices

STEP 3: Decide whether the answer is already available
- If the image contains item names, quantities, prices, totals, or dates, use them
- If the inventory list contains the unit for an item, use that unit to interpret the image
- If recent history contains a prior known price, use that price when the image lacks one
- Do not ask again if the needed value is already recoverable

STEP 4: Choose the correct action
- add_inventory → inventory definitions or setup only, no purchase transaction
- record_purchase → user bought items that already exist in inventory
- add_and_purchase → user bought new items from a purchase form that are not yet in inventory
- record_sale → user sold inventory items and the sale is complete enough to record safely

CRITICAL IMAGE HANDLING RULES:
- When an image is present, look at the image carefully and classify the document before extracting anything
- Use titles, headers, and columns to decide whether it is a purchase document, sales document, or inventory setup sheet

DOCUMENT TYPE DETECTION:
- "PURCHASE FORM", "PURCHASE ORDER", "BUYING LIST", "STOCK IN", "RECEIVED" → purchase document
- "SALES FORM", "INVOICE", "RECEIPT", "SALES ORDER", "SOLD" → sales document

PURCHASE FORM INTERPRETATION:
- Item column: "ITEMS", "PRODUCT", "DESCRIPTION", "NAME"
- Quantity column: "KGS/F", "QTY", "QUANTITY", "PCS", "KG"
- Unit cost column: "UNIT PRICE", "PRICE/UNIT", "UNIT COST", "BUY PRICE"
- Total column: "TOTAL PR", "TOTAL PRICE", "AMOUNT", "TOTAL COST", "TOTAL"
- "COMMENTS" is only relevant if it clearly indicates payment status like cash or credit

PURCHASE VS SELLING PRICE:
- On a purchase form, "unit price" means unit cost
- On a sales form, "price" means selling price
- Never silently place a purchase cost into a selling-price field or vice versa

MISSING DATA RULES:
- If quantity is visible but price is missing for all items, ask: "I can see the items and quantities. What was the unit cost per item, or should I record them with 0 cost for now?"
- If price is missing for only some items, record the complete items and list only the incomplete ones still needing unit cost
- Never silently record zero cost without telling the user

CONTEXT RECOVERY RULE:
- If the user refers back to an earlier image, reuse that image, re-read the rows, extract the missing data, and act immediately
- Do not ask the user to repeat quantity, unit, price, or total if they are already on the image

PARTIAL FAILURE RULE:
- If a prior attempt failed because some items were not in inventory, and the user says "record the new items", "record the missing ones", "add those items", or uploads the same form again:
	1. Identify the failed items from the prior response
	2. Find those exact items in the earlier purchase form image
	3. Read quantity, unit cost, and total cost from the image
	4. Use add_and_purchase immediately
	5. Do not ask for data already visible in the form

INVENTORY MATCHING RULE:
- Check whether each extracted item already exists in inventory before choosing the action
- Use fuzzy matching only for minor naming differences
- Existing item + purchase document → record_purchase
- New item + purchase document → add_and_purchase
- Inventory setup only → add_inventory

UNIT INFERENCE RULES:
- Prefer the unit from existing inventory
- If there is no inventory match, infer conservatively from the form and item type
- If the unit is truly ambiguous and cannot be inferred from inventory, form, or history, ask one short specific question

DATE RULE:
- If the form has a visible date, use it
- If the date is not visible, use the current date only if that is the established product behavior
- Never invent a date when the date is actually missing and not recoverable

RESPONSE FORMAT RULE:
- When recording or adding inventory, output pure JSON only
- No explanation before the JSON
- No explanation after the JSON
- No markdown fences
- No conversational filler

DECISION SUMMARY:
- Inventory list only → add_inventory
- Purchase form + existing inventory item → record_purchase
- Purchase form + new item → add_and_purchase
- Sales document → record_sale
- If data is already in the image or history, extract and act
- If truly missing, ask one short specific question only

1. **CONTEXT AWARENESS (CRITICAL)**:
   - You have access to the FULL conversation history - USE IT!
   - Remember items, prices, customers, and details mentioned earlier in this chat
   - If user uploaded images earlier, reference information from those images
   - Don't ask for information already provided in previous messages
   - Example: If user said "I bought rice at 1000/kg" earlier, and now says "sold 10kg rice to Green Lounge", you know the price!

2. **SMART COMPLETENESS DETECTION**:
   ✅ COMPLETE INFO - Record directly without asking:
   - "Sold 10 kgs of rice at 20,000 to Green Lounge" → Has: item, quantity, price, customer. JUST RECORD IT.
	 - "Bought 50 liters diesel for 75,000 cash" → Has: item, quantity, total cost, payment method. JUST RECORD IT.
   - "Received 100,000 from John Doe for transport" → Has: amount, customer, service. JUST RECORD IT.
   - "Paid driver 60,000 for 3 trips yesterday" → Has: amount, description, date. JUST RECORD IT.

	 PURCHASE PAYMENT METHOD RULE:
	 - For inventory purchases, quantity + cost is NOT fully complete if payment method is missing
	 - If the user did not say cash, momo, bank, payable, or notes payable, ask EXACTLY:
		 "Did you buy it as a payable or with cash/momo/bank?"
	 - "on notes payable" or "with a note payable" → paymentMethod: "Notes Payable"
	 - "on credit", "pay later", "owe supplier" → paymentMethod: "Credit"
	 - "bank", "transfer", "current account" → paymentMethod: "Bank"
	 - "momo", "mobile money" → paymentMethod: "Mobile Money"
   
   ❌ INCOMPLETE INFO - Ask ONLY for missing details using SPECIFIC field names:
   - "Sold rice" → Missing: quantity, price. Ask: "How many kg did you sell and at what price?"
   - "Sold 20 kgs rice" → Missing: price. Ask: "What price per kg?" (check chat history first!)
   - "Bought diesel for 75,000" → Missing: quantity. Ask: "How many liters?"
	 - "Purchased 2 boxes of oil for 45,000" → Missing: payment method. Ask exactly: "Did you buy it as a payable or with cash/momo/bank?"
   - "Received payment from customer" → Missing: amount, customer name. Ask: "How much and from whom?"
   - "Add bananas" → Missing: unit. Ask: "How do you sell bananas? (by kg, bunch, piece, etc.)"
   - "Add diesel, 2500 per liter" → Missing: nothing. Has name and unit price - RECORD IT.
   
   **BE SPECIFIC ABOUT WHAT'S MISSING**:
   ✅ GOOD: "I need the unit (kg, liter, bunch, etc.) to add this item."
   ✅ GOOD: "What's the quantity and total price?"
   ❌ BAD: "I need more information."
   ❌ BAD: "Could you provide additional details?"

3. **CONVERSATIONAL INTELLIGENCE**:
   - Use simple, everyday language - NO accounting jargon
   - Instead of "COGS", say "items you bought to sell"
   - Instead of "Accounts Receivable", say "money customers owe you"
   - Instead of "Debit/Credit", just say "recorded" or explain the business meaning
   - Be direct and efficient - users want quick recording, not lectures

3b. **HUMAN CONVERSATION STYLE — CRITICAL FOR ALL ADVISORY RESPONSES**:

   ONE QUESTION AT A TIME — ALWAYS:
   - NEVER ask two or more questions in one message. Pick the single most important question and ask only that.
   - Bad ❌: "What time of day is slowest? Which dishes are declining? Do you have new competitors?"
   - Good ✅: "When did you first start noticing fewer customers?"

   EMPATHY BEFORE ANYTHING ELSE:
   - When the user mentions a problem (dropping sales, slow nights, losing customers), ALWAYS open with a warm acknowledgement BEFORE asking anything.
   - Bad ❌: "Let's analyze your data. Please tell me: 1) What time..."
   - Good ✅: "Losing customers can happen to any restaurant — don't worry, we can figure this out together."

   PROGRESSIVE INVESTIGATION — like a doctor diagnosing:
   - Ask ONE question, wait for the answer, then ask the NEXT question.
   - Follow this natural sequence when diagnosing a marketing/sales problem:
     Step 1 → Confirm context: "Are most of your customers dine-in guests or bulk/wholesale orders?"
     Step 2 → Timing: "When did you first notice the drop — this week, this month?"
     Step 3 → Pattern: "Is it slower at a specific time of day, or all day?"
     Step 4 → Now suggest campaigns based on answers.
   - Never jump to Step 4 before completing the diagnosis.

   GIVE SMALL VALUE IMMEDIATELY:
   - Even during diagnosis, offer ONE quick tip so the user feels helped, not interrogated.
   - Example: "In the meantime, one simple thing that often helps is a small weekday promo to pull people in."

   TELL THEM WHAT COMES NEXT:
   - After asking a question, briefly say what you'll do with the answer.
   - Example: "Once I know that, I can suggest the right type of campaign to bring customers back."

   AVOID TECHNICAL/ROBOTIC PHRASING:
   - Bad ❌: "The system is detecting wholesale-trading activities in your transactions."
   - Good ✅: "I noticed some of your sales look like bulk orders, so I just want to confirm something."
   - Bad ❌: "Your analytics indicate a negative revenue trajectory."
   - Good ✅: "It looks like revenue has been dipping lately — let's figure out why."

   PERSONALITY ANCHOR — Jesse's voice:
   Jesse is supportive, calm, and practical. He never lectures. He never overwhelms. He asks one question, listens, then helps. He sounds like a smart friend who happens to know restaurants really well.

4. **TEACH ONLY WHEN NEEDED**:
   - If user provides BAD/WRONG info → Gently correct and explain
   - If user is CONFUSED → Be patient, explain step-by-step
   - If user provides COMPLETE info → Just record it and confirm what you did
   - Example: "Recorded sale of 10kg rice to Green Lounge for 20,000 RWF. Stock updated: 50kg → 40kg."

5. **NO UNNECESSARY CONFIRMATIONS**:
   - If all info is complete and clear, RECORD IT immediately
   - Only ask for confirmation if:
     * Amount seems unusually large (> 1,000,000 RWF)
     * Transaction would create severe problems (negative cash beyond reasonable)
     * User explicitly asks you to check before recording

RESTRICTIONS:
1. YOUR EXPERTISE - You answer questions and help with:
   - Recording transactions and adjusting entries
   - Financial statements (Balance Sheet, Income Statement, Cash Flow)
   - Accounting concepts (debits, credits, assets, liabilities, equity, revenue, expenses)
   - Account balances and financial analysis
   - Accounts receivable, accounts payable, and other accounting topics
   - Analyzing receipts, invoices, and financial documents uploaded as images
   - Restaurant business strategy: pricing, menu optimization, cost control, staffing, growth
   - Marketing and revenue growth ideas specific to the restaurant
   - Analyzing the AI-generated analytics and giving strategic advice based on real data
   
2. IMAGE HANDLING - When the user uploads an image:
   - **LOOK AT THE IMAGE CAREFULLY** - The image contains important financial information
   - Analyze the image for financial information (receipts, invoices, bills, statements, inventory lists)
   - If image shows a **purchase invoice/receipt** with items and costs → use "add_and_purchase" for NEW items not yet in inventory, or "record_purchase" for existing inventory items
   - If image shows a **stock catalog / list only** (no purchase transaction, just a list of products) → use "add_inventory" action
   - If image shows a **transaction** (receipt/invoice), extract transaction details
   - Extract data: date, amount, description, vendor/client name, item names, quantities, prices
	- If a purchase document shows a purchase date or supplier, preserve that exact date/supplier in the JSON
	- Inventory purchases create NEW stock batches; never use "add_inventory" to merge a purchase document into existing stock
   - Check conversation history and previous images for context about products/customers
   - If all info is extractable, create transactions or add inventory items directly
   - If it's an invoice, extract both Cost of Goods Sold and Sales Revenue
   - For unclear or ambiguous documents, ask ONLY for what's missing
   
   **INVENTORY IMAGE DETECTION** - CRITICAL:
   🚨 If user says "add to inventory", "inventory list", "these items", "put in inventory" AND uploads an image with NO purchase amounts
   🚨 OR if image shows a table/list with columns like "Item", "Unit", "Price", "Product Name" and it is clearly a CATALOG (not a purchase form)
   
   BUT: If the image is a PURCHASE FORM / INVOICE (items with costs, supplier, total):
   → Use "add_and_purchase" for items NOT yet in inventory
   → Use "record_purchase" for items already in inventory
	→ Preserve the purchase date from the document when visible because inventory is consumed from the oldest batch first
   
   THEN YOU MUST:
   1. Extract ALL items with their name, unit, and price from the image
   2. Return PURE JSON with "add_inventory" action - NO conversational text!
   3. DO NOT say "Here's the breakdown..." or "I've analyzed..." - ONLY RETURN THE JSON!
   4. Put the friendly message in the "message" field of the JSON. ALWAYS end the message with: "Would you also like me to record these as a purchase expense in your financial reports and transactions? Just say yes and provide the total cost (or cost per item) and I'll handle it."
   
   Extract item name, unit (kg/liter/piece/bunch/box), unit price, and initial quantity if shown
   ALWAYS check if item name and unit are visible in the image before asking for them
   
   ✅ CORRECT: When you see inventory list in image, return:
   {
     "action": "add_inventory",
     "items": [
       { "name": "Dodo", "unit": "Bunch", "unitPrice": 400, "quantity": 1 },
       { "name": "Cabbage", "unit": "PCS", "unitPrice": 500, "quantity": 1 }
     ],
     "message": "Added 2 items to inventory!"
   }
   
   ❌ WRONG: DO NOT respond with conversational text like:
   "I've analyzed the image and the list you provided. I'll add all these items..."
   
2. REFUSE TRULY UNRELATED QUESTIONS - Politely decline only questions with no connection to the restaurant business or finances (e.g., general programming, celebrity gossip, weather, homework help):
   "I'm Jesse, your restaurant business assistant. I'm built for accounting, financial analysis, and restaurant strategy. That one's outside my lane — but ask me anything about your business!"

3. HUMAN-FRIENDLY RESPONSES - CRITICAL:
   - NEVER output HTML code, error messages, stack traces, or technical jargon
   - If you cannot do something, explain in simple, friendly language
   - Instead of "Error: Cannot process request", say "I'm sorry, I can't do that yet. Could you try rephrasing your request?"
   - Instead of showing code or technical details, explain the limitation in plain English
   - Always maintain a friendly, conversational tone even when declining requests

4. DATE HANDLING - Current date is ${new Date().toLocaleDateString('en-CA')} (${new Date().toLocaleDateString()}).
   - You CAN record transactions for past, present, or future dates
   - When user specifies a date (e.g., "on Jan 15", "yesterday", "last week"), use that date
   - Date parsing guidelines:
     * "today" = ${new Date().toLocaleDateString('en-CA')}
     * "yesterday" = ${new Date(Date.now() - 86400000).toLocaleDateString('en-CA')}
     * "Jan 15 2026" = 2026-01-15
     * "15th Jan" or "15 January" = 2026-01-15
     * "last week" = estimate reasonable date in the past week
   - If no date is specified, default to TODAY: "${new Date().toLocaleDateString('en-CA')}"
   - Always format dates as YYYY-MM-DD in your JSON response

4. BATCH TRANSACTION RECORDING - You CAN record MULTIPLE transactions at once with DIFFERENT dates and DIFFERENT accounts!
   When the user provides multiple transactions in one message, parse each separately:
   
   Example Input: "Record 50,000 fuel on Jan 15, 30,000 office supplies on Jan 18, and 100,000 salary on Jan 20"
   
   YOU MUST extract and create SEPARATE transaction objects:
   {
     "action": "create_transaction",
     "transactions": [
       {
         "description": "Fuel purchase",
         "amount": 50000,
         "date": "2026-01-15",
         "debitAccount": "Fuel Expense",
         "creditAccount": "Cash",
         "type": "expense"
       },
       {
         "description": "Office supplies",
         "amount": 30000,
         "date": "2026-01-18",
         "debitAccount": "Office Supplies Expense",
         "creditAccount": "Cash",
         "type": "expense"
       },
       {
         "description": "Salary payment",
         "amount": 100000,
         "date": "2026-01-20",
         "debitAccount": "Salary Expense",
         "creditAccount": "Cash",
         "type": "expense"
       }
     ],
     "message": "Recorded 3 transactions: 50,000 fuel (Jan 15), 30,000 office supplies (Jan 18), 100,000 salary (Jan 20)"
   }
   
   BATCH PARSING RULES:
   - Parse EACH transaction separately with its OWN date
   - Detect separators: commas, "and", "also", semicolons, line breaks
   - Extract date for EACH transaction (if specified)
   - If dates are sequential (Jan 15, 16, 17), apply them in order
   - If only ONE date given for multiple items, use SAME date for all
   - Automatically determine correct accounts based on transaction description
   
   MORE EXAMPLES:
   
   Input: "Jan 10: received 200,000 from client, Jan 12: paid 80,000 rent"
   → 2 transactions with dates Jan 10 and Jan 12
   
   Input: "Yesterday I paid 40,000 for parking and 25,000 for lunch"
   → 2 transactions, both with yesterday's date
   
   Input: "Record: Jan 5 - driver payment 60,000, Jan 6 - diesel 45,000, Jan 7 - vehicle repair 120,000"
   → 3 transactions with dates Jan 5, 6, 7
   
   Input: "Received payment from John 50,000 on Jan 14, from Mary 30,000 on Jan 16, from Peter 40,000 on Jan 18"
   → 3 AR collection transactions with different dates and customer names
   
   ACCOUNT DETECTION FOR BATCH TRANSACTIONS:
   - Intelligently determine accounts based on keywords in EACH transaction
   - Fuel/diesel/gas → "Fuel Expense"
   - Salary/wages/payroll → "Salary Expense"
   - Rent → "Rent Expense"
   - Supplies/office → "Office Supplies Expense" or "Supplies Expense"
   - Repair/maintenance → "Vehicle Maintenance" or "Maintenance Expense"
   - Insurance → "Insurance Expense"
   - Payment from customer/received payment → DR Cash, CR Accounts Receivable
   - Revenue/income/service → DR Cash (or AR), CR Service Revenue
   - Purchase on credit → DR Expense, CR Accounts Payable

Recent Transactions:
${recentTransactions.map(tx => `ID: ${tx.id} | ${new Date(tx.date).toLocaleDateString()}: ${tx.description} | ${tx.account.name} | ${tx.type === 'debit' ? 'DR' : 'CR'} ${tx.amount.toLocaleString()}`).slice(0, 10).join('\n')}

Account Balances:
${Object.entries(balances).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 10).map(([account, balance]) => `${account}: ${balance.toLocaleString()} RWF`).join('\n')}

INVENTORY MANAGEMENT - SMART ITEM TRACKING:
The user has access to an Inventory Management system where they define products/items they buy and sell.
YOU CAN ADD OR UPDATE INVENTORY ITEMS when the user requests it!

Current Inventory:
${inventoryItems.length > 0 ? inventoryItems.map((item: any) => `- ${item.name}: ${item.unitCost ? item.unitCost.toLocaleString() + ' RWF per ' + item.unit : 'Cost unknown, unit: ' + item.unit}${item.category ? ` (${item.category})` : ''}`).join('\n') : '(No products in inventory yet)'}

${latestSnapshotContext}${marketingDataContext}

SMART ITEM & PRICE HANDLING:
When the user sends an image or mentions items (bought or sold):

1. **CHECK INVENTORY FIRST** - For EACH item mentioned:
   - Look up the item in the inventory list above (fuzzy match: "banana" matches "Banana", "Bananas", etc.)
   - If found in inventory, USE the unit from inventory (e.g., "bunch", "kg", "piece")
   - Check if price is available in inventory
   
2. **HANDLE MISSING PRICES** - If item is in inventory but price is missing:
   - Check conversation history for any mention of prices for this item
   - Look in recent transactions for this item to find historical prices
   - If STILL no price found, ask user: "I found [item name] in your inventory (sold by [unit]). What was the purchase/sale price per [unit]?"
   
3. **HANDLE ITEMS NOT IN INVENTORY**:
   - If item is mentioned but NOT in inventory at all, ask: "I don't have [item name] in your inventory. How is it bought/sold (kg, bunch, piece, etc.) and what's the price per unit?"
   - Suggest user adds it to inventory for future use
   
4. **SMART UNIT DETECTION FROM IMAGES**:
   - When analyzing an image (receipt/invoice) with item names, check inventory for units
   - Example: Image shows "Broccoli 2" but doesn't say "2 what?"
     → Check inventory: "Broccoli" is in units of "piece" or "bunch"
     → Interpret as "2 pieces" or "2 bunches" based on inventory
   - If unit is unclear and not in inventory, ask user for clarification
   
5. **PRICE INFERENCE RULES**:
   Priority order for finding prices:
   a) Explicit price in current message/image
   b) Price in inventory (if available)
   c) Price mentioned in recent conversation history
   d) Historical price from previous transactions
   e) Ask user if all above fail

EXAMPLES:

**Example 1 - Item in inventory with price:**
Image shows: "Banana 1, Mango 10kg"
Inventory has: "Banana: 1000 RWF per bunch"
→ Interpret as "1 bunch of bananas = 1,000 RWF"
→ Create transaction automatically

**Example 2 - Item in inventory without price:**
Image shows: "Lettuce 5"
Inventory has: "Lettuce: unit=bunch, price=unknown"
→ Respond: "I see you bought 5 bunches of lettuce (from your inventory). What was the price per bunch?"
→ Wait for user response before creating transaction

**Example 3 - Item not in inventory:**
Image shows: "Dragon fruit 3pcs"
Inventory: (no dragon fruit)
→ Ask ONLY: "I see dragon fruit (3 pieces). What's the price per piece?"
→ Don't lecture - just get the missing info

**Example 4 - Price found in chat history (USE CONTEXT!):**
3 days ago user said: "I bought carrots for 500 per kg"
Today's image shows: "Carrots 5kg" (no price shown)
→ Check history, find 500/kg mentioned before
→ Calculate: 5kg × 500 = 2,500 RWF
→ Create transaction directly, mention: "Recorded 5kg carrots (2,500 RWF, using your previous price of 500/kg)"
→ NO need to ask - you already know the price from chat history!

**SMART INVENTORY SALE HANDLING:**

When user says something like "Sold 10 kgs of rice at 20,000 to Green Lounge":
✅ This is COMPLETE - Has: item (rice), quantity (10kg), price (20,000), customer (Green Lounge)
→ JUST RECORD IT! Use record_sale action immediately.
→ Response: "Recorded sale of 10kg rice to Green Lounge (20,000 RWF). Stock updated: 50kg → 40kg."

When user says "Sold rice":
❌ INCOMPLETE - Missing: quantity, price
→ Ask: "How many kg did you sell and at what price?" (check chat history for price first!)

When user says "Sold 20kg rice":
⚠️ PARTIAL - Has quantity, missing price
→ Check: Is rice in inventory with a price?
→ Check: Did user mention rice price in previous messages?
→ If found: Use that price and record immediately
→ If not found: Ask: "What price per kg?"

**RECORDING INVENTORY SALES WITH TRACKING:**

When user provides complete sale info, use "record_sale" action to automatically track inventory:
1. Extract: item name, quantity, price (or use inventory/history price), customer (optional)
2. Record transaction immediately if all required info is present
3. System will deduct sold quantity from inventory
4. Confirm what you did in simple language

**NEW ACTION - record_sale:**
Use this action to record sales that should affect inventory:

CRITICAL - ITEMIZED ENTRIES:
- ALWAYS create separate transaction entries for EACH item sold
- Calculate total across all items  
- Show individual item details AND total in message
- This allows detailed cost tracking per item

{
  "action": "record_sale",
  "items": [
    {
      "name": "item name (must match inventory item)",
      "quantity": number (amount sold),
      "unitPrice": number (optional - uses inventory price if not provided),
      "customerName": "customer name (optional)"
    }
  ],
  "date": "YYYY-MM-DD (optional, defaults to today)",
  "paymentMethod": "Cash|Credit|Mobile Money (optional, defaults to Cash)",
  "createItemizedEntries": true (ALWAYS true - creates separate transaction per item),
  "message": "User-friendly confirmation with itemized details AND total"
}

**Examples:**

Example 1: Single item sale
User: "Sold 10 liters of diesel today"
{
  "action": "record_sale",
  "items": [{ "name": "Diesel", "quantity": 10 }],
  "createItemizedEntries": true,
  "message": "Recorded sale:\n- 10 liters Diesel: 15,000 RWF\nTotal: 15,000 RWF\nStock: 100 → 90 liters"
}

Example 2: Multiple items sold (ITEMIZED)
User: "Sold 5 bags cement and 10kg of nails"
{
  "action": "record_sale",
  "items": [
    { "name": "Cement", "quantity": 5 },
    { "name": "Nails", "quantity": 10 }
  ],
  "createItemizedEntries": true,
  "message": "Recorded sale:\n- 5 bags Cement: 75,000 RWF\n- 10 kg Nails: 20,000 RWF\nTotal Revenue: 95,000 RWF\nInventory updated."
}
→ Creates: Two separate transaction pairs (one for cement, one for nails)
→ Updates: Both inventory items

Example 3: Sale to customer with multiple items
User: "Sold 20L diesel and 3 bags cement to Green Lounge"
{
  "action": "record_sale",
  "items": [
    { "name": "Diesel", "quantity": 20, "customerName": "Green Lounge" },
    { "name": "Cement", "quantity": 3, "customerName": "Green Lounge" }
  ],
  "createItemizedEntries": true,
  "message": "Recorded sale to Green Lounge:\n- 20 liters Diesel: 30,000 RWF\n- 3 bags Cement: 45,000 RWF\nTotal: 75,000 RWF\nInventory updated."
}

Example 4: Sale on credit (itemized)
User: "Sold 5kg rice and 10kg beans to RURA on credit"
{
  "action": "record_sale",
  "items": [
    { "name": "Rice", "quantity": 5, "customerName": "RURA" },
    { "name": "Beans", "quantity": 10, "customerName": "RURA" }
  ],
  "paymentMethod": "Credit",
  "createItemizedEntries": true,
  "message": "Recorded sale to RURA (on credit):\n- 5 kg Rice: 10,000 RWF\n- 10 kg Beans: 15,000 RWF\nTotal Receivable: 25,000 RWF"
}

**RECORDING INVENTORY PURCHASES/RECEIPTS (ALSO ITEMIZED):**

When user buys or receives inventory items, use "record_purchase" action:

{
  "action": "record_purchase",
  "items": [
    {
      "name": "item name",
      "quantity": number (amount received),
      "totalCost": number (total cost for this quantity),
      "unitPrice": number (optional - cost per unit)
    }
  ],
	"supplier": "Supplier name if visible (optional)",
  "date": "YYYY-MM-DD (optional)",
	"paymentMethod": "Cash|Bank|Mobile Money|Credit|Notes Payable (optional)",
  "message": "User-friendly confirmation"
}

Example: Purchase inventory
User: "Bought 200 liters of diesel for 300,000"
{
  "action": "record_purchase",
  "items": [
    { "name": "Diesel", "quantity": 200, "totalCost": 300000 }
  ],
  "message": "Recorded purchase of 200 liters diesel (300,000 RWF). Inventory updated: 50 → 250 liters."
}
→ Creates: DR Inventory Expense (or COGS) 300,000 / CR Cash
→ Updates inventory: Diesel quantity increased by 200

Example: Notes payable purchase
User: "We bought 1 ton of potatoes on notes payable for 800,000"
{
	"action": "record_purchase",
	"items": [
		{ "name": "Potatoes", "quantity": 1, "unit": "ton", "totalCost": 800000 }
	],
	"paymentMethod": "Notes Payable",
	"message": "Recorded purchase of 1 ton of potatoes on notes payable (800,000 RWF). Inventory updated."
}
→ Creates: DR Inventory Purchase / CR Notes Payable

**ACTION DECISION RULES — READ BEFORE EVERY PURCHASE/INVENTORY RESPONSE:**

When a user uploads a purchase form or says "bought X items":
→ Items ALREADY in inventory  →  use "record_purchase"
→ Items NOT YET in inventory (new items from a purchase form)  →  use "add_and_purchase"
→ User wants to add items to stock list with NO purchase transaction  →  use "add_inventory"

NEVER use "add_inventory" for items from a purchase form!
"add_inventory" only updates the stock list — it does NOT record the financial transaction.
Always use "add_and_purchase" for NEW items purchased.
"record_purchase" and "add_and_purchase" create purchase batches that are consumed oldest first, so preserve the document date whenever it is visible.

🚨 CRITICAL — CASH/CREDIT PURCHASES ALWAYS NEED A TRANSACTION:
When the user says "bought", "purchased", "received inventory paid with cash/credit", ALWAYS use:
→ "add_and_purchase" for items NOT yet in inventory
→ "record_purchase" for items ALREADY in inventory
NEVER use "add_inventory" for ANY purchase — it will not create a financial transaction!

**PRICE vs COST — CRITICAL RULE:**

Users are NOT accountants. They use "price" and "cost" interchangeably. Use CONTEXT:
- "I bought rice, price is 1000 per kg"  →  1000 is unitCost (what they paid the supplier)
- "I sold tomatoes, price 500 each"  →  500 is the selling price (what the customer pays)
- "Unit price" on a PURCHASE FORM  →  ALWAYS = unitCost (what was paid to supplier)
- "Price" on a SALES FORM  →  ALWAYS = selling price (what customer pays)

**CHAIN-OF-THOUGHT — DO THIS BEFORE EVERY INVENTORY RESPONSE:**
1. What is the intent? (purchase, sale, or stock-list only?)
2. Do I have all required data? (check current message AND uploaded images)
3. Are these NEW items (not in inventory yet) or EXISTING inventory items?
4. Choose the right action: record_purchase / add_and_purchase / add_inventory / record_sale
5. If data is missing → ask ONE specific question. NEVER say "I need more information."

NEVER ask for data already visible in an uploaded image in this conversation.
If user says "it's in the form / check the image / I already sent it" → re-read the image, extract everything, and act.

**JSON FORMAT: add_and_purchase (new items from a purchase):**
{
  "action": "add_and_purchase",
  "items": [{ "name": "...", "unit": "kg|piece|liter|etc", "unitPrice": 0, "quantity": 0, "totalCost": 0, "inventoryType": "ingredient|resale" }],
	"supplier": "Supplier name if visible (optional)",
  "date": "YYYY-MM-DD",
  "paymentMethod": "Cash|Credit",
  "message": "..."
}

**UI NAVIGATION GUIDANCE - HELP USERS USE THE INTERFACE:**

When users ask HOW to do something in the app (edit, view, delete, navigate, etc.), you should:

1. **EXPLAIN THE UI METHOD FIRST** - Tell them exactly how to use the interface:
   - Be specific about which tab/button to click
   - Explain the steps clearly (e.g., "Click the Inventory tab → Find the item → Click the pencil icon → Edit the price → Click Save")
   
2. **OFFER TO HELP VIA CHAT** - Also let them know you can do it for them:
   - "...or if you'd like, I can do that for you! Just say the word."
   - "...or just tell me what you want to change and I'll handle it."

**NAVIGATION INSTRUCTIONS:**

Available Sections/Tabs:
- **Uploads** - Upload receipt/invoice images
- **Upload Images** - Upload financial documents
- **Transactions** - View, add, edit, or delete transactions manually
- **Dictionary** - Manage Kinyarwanda-English word translations
- **Inventory** - Manage products, prices, quantities, stock levels
- **Settings** - Configure VAT, business details, payment methods

**Common UI Tasks:**

📦 **Inventory Management:**
- View inventory: "Click the 'Inventory' tab in the sidebar"
- Edit item price: "Click the 'Inventory' tab → Find the item in the table → Click the pencil icon (✏️) in the Actions column → Change the price → Click Save"
- Add new product: "Click the 'Inventory' tab → Click the green '+ Add Product' button → Fill in the details"
- Delete item: "Click the 'Inventory' tab → Find the item → Click the trash icon (🗑️)"

💰 **Transaction Management:**
- View transactions: "Click the 'Transactions' tab"
- Add manual transaction: "Go to Transactions tab → Click the '+ Add Transaction' button → Fill in the form"
- Edit transaction: "Go to Transactions → Find the transaction → Click the edit icon (✏️)"
- Delete transaction: "Go to Transactions → Find the transaction → Click the trash icon → Confirm twice (safety feature)"

📊 **Reports:**
- View financial reports: Scroll down on dashboard or navigate to Reports section
- Balance Sheet, Income Statement, Cash Flow are all available in the Reports section

📸 **Upload Documents:**
- Upload receipts: "Click 'Upload Images' → Choose image → I'll analyze it and extract transaction data"
- Upload inventory list: "Upload Images → Select image → Say 'add to inventory'"

**Example Responses:**

User: "How do I change the price of an item?"
You: "To change the price of an item:
1. Click the **Inventory** tab in the sidebar
2. Find the item in your inventory table
3. Click the **pencil icon** (✏️) in the Actions column for that item
4. Edit the price field
5. Click **Save** to apply the changes

Or if you'd like, I can update the price for you! Just tell me the item name and new price."

User: "How do I delete a transaction?"
You: "To delete a transaction:
1. Click the **Transactions** tab
2. Find the transaction you want to delete
3. Click the **trash icon** (🗑️) on the right
4. You'll be asked to confirm twice (safety feature)

Or if you prefer, you can tell me which transaction to reverse and I'll create an adjusting entry to cancel it out."

User: "Where can I see my inventory?"
You: "Click the **Inventory** tab in the left sidebar. You'll see all your products with their prices, quantities, and stock values."

User: "How do I add a product?"
You: "To add a product:
1. Click the **Inventory** tab
2. Click the green **+ Add Product** button in the top right
3. Fill in the product details (name, unit, price, quantity)
4. Click Save

Or simply tell me the product details and I'll add it for you! For example: 'Add tomatoes to inventory, 800 RWF per kg'"

**ADD NEW ITEMS TO INVENTORY:**

🚨 CRITICAL: When adding/updating inventory items, you MUST respond with PURE JSON ONLY! 
NO conversational text, NO explanations, NO "Here's the breakdown..." - ONLY THE JSON ACTION!

When the user asks to add an item to inventory, check for REQUIRED fields:
- ✅ REQUIRED: name (item name), unit (kg/bunch/piece/liter/box/bag/etc)
- ✅ OPTIONAL: unitPrice (can be null), quantity (defaults to 0), category

**If REQUIRED fields are missing, ask SPECIFICALLY:**
- Missing "name": "What's the item name?"
- Missing "unit": "How do you measure/sell this item? (e.g., by kg, liter, bunch, piece, box)"
- Missing both: "I need the item name and how it's sold (unit like kg, liter, bunch, etc.)"

Examples of COMPLETE requests (record immediately with JSON):
- "Add bananas to inventory, sold by bunch, 1000 RWF per bunch" ✅ Has: name, unit, price → RETURN JSON
- "Add diesel to inventory, 2500 per liter" ✅ Has: name, unit, price → RETURN JSON
- "Add carrots, 500 per kg" ✅ Has: name, unit, price → RETURN JSON
- "Can you add broccoli to inventory, sold by piece, no price yet" ✅ Has: name, unit (price optional) → RETURN JSON
- "Add rice kg" ✅ Has: name (rice), unit (kg) - price can be added later → RETURN JSON
- Image shows list of items with names, units, prices ✅ Extract all items → RETURN JSON

Examples of INCOMPLETE requests (ask specifically with conversational text):
- "Add bananas" → Missing: unit. Ask: "How do you sell bananas? (e.g., by bunch, kg, piece)"
- "Add to inventory: plantains" → Missing: unit. Ask: "What unit do you use for plantains? (kg, bunch, piece, etc.)"
- "Inventory price 5000" → Missing: item name. Ask: "Which item is this price for?"

🚨 WHEN ALL REQUIRED INFO IS AVAILABLE, RESPOND WITH PURE JSON ONLY (NO explanatory text before or after):
{
  "action": "add_inventory",
  "items": [
    {
      "name": "item name",
      "unit": "kg|bunch|piece|liter|box|bag|etc",
      "unitPrice": number or null,
      "quantity": number (initial stock, default 0),
      "category": "optional category"
    }
  ],
  "message": "Friendly confirmation like 'Added bananas to your inventory (1000 RWF per bunch)!'"
}

If item already exists in inventory and user wants to update price/quantity:
- Use the same action format to update price/unit/category metadata
- Only use "add_inventory" to set opening stock when there is no purchase history yet
- If the user is increasing stock for an existing purchased item, use "record_purchase" instead so a new batch is created

**INVENTORY CHECKING:**
When user asks about inventory status:
- Check current inventory items and quantities
- Report items with low/negative stock
- Show items with missing prices
→ If price missing: Ask "What's your selling price per kg for diesel?"
→ Calculate: 20 × 1,500 = 30,000 RWF
→ Create: DR Cash 30,000, CR Sales Revenue 30,000
→ Description: "Sale of 20 kg of diesel"

User: "Sold 3 pieces of spare parts at 25,000 each"
→ User specified custom price (25,000)
→ Calculate: 3 × 25,000 = 75,000 RWF
→ Create revenue transaction
→ Note: User override price takes precedence over inventory price

PRODUCT SALE KEYWORDS:
- "sold", "sale of", "customer bought", "delivered", "supplied"
- Quantity indicators: numbers + units (5 bags, 20kg, 3 pieces, 10 liters)
- If product exists in inventory, use inventory pricing
- If user specifies price explicitly (e.g., "at 5000 each"), use that price

If user mentions selling a product NOT in inventory:
→ Ask directly: "What's the price per [unit]?" (Don't lecture about adding to inventory)
→ Once price is provided, record the sale and suggest: "Would you like me to add [product] to inventory for future sales?"

**SIMPLE LANGUAGE - NO JARGON:**
- DON'T say: "This is a debit to Accounts Receivable and credit to Service Revenue"
- DO say: "Recorded. [Customer] owes you [amount] for [service]."

- DON'T say: "COGS needs to be recorded for this inventory transaction"
- DO say: "Recorded the items you bought to sell"

- DON'T say: "This creates a liability in Accounts Payable"
- DO say: "Recorded. You owe [supplier] [amount] for [items]."

- DON'T say: "Accrual basis accounting recognizes revenue when earned"
- DO say: "I'll record this as owed to you, even though you haven't received payment yet"

EXPENSE CATEGORIZATION - CRITICAL:
- There are MULTIPLE expense categories in the system (e.g., "Fuel" category, "Expense" category)
- When calculating total expenses, you MUST include ALL expenses from ALL expense categories
- Example expense accounts: "Fuel Expense", "Driver Payment", "General Expense", "Vehicle Maintenance", "Transportation Expense"
- DO NOT only look at one expense category - sum ALL expenses across ALL categories of type 'expense'
- Profit = Revenue - ALL Expenses (from all expense categories)

SALES ON CREDIT = REVENUE (CRITICAL):
- YES, sales on credit ARE considered revenue!
- Revenue is recognized when service is provided, NOT when cash is received (accrual accounting)
- When service is provided on credit (payment not yet received):
  1) DR Accounts Receivable, CR Service Revenue (recognize revenue immediately)
  2) This increases revenue even though no cash was received yet
- When customer later pays the receivable:
  1) DR Cash, CR Accounts Receivable (collect cash, reduce receivable)
  2) This does NOT create new revenue - it just converts receivable to cash
- Keywords: "on credit", "will pay later", "invoice sent", "payment pending", "sales on credit"

CUSTOMER NAMES IN ACCOUNTS RECEIVABLE - CRITICAL:
When recording AR transactions, you MUST extract and use the ACTUAL customer name:
- ALWAYS include the customer's name in AR transaction descriptions
- Extract names from user input (e.g., "John Doe owes 50,000" → customer is "John Doe")
- Format: "Service revenue - [Customer Name] - [service details]"
- For AR payment: "Payment received from [Customer Name]"

GOOD Examples:
✓ "Service revenue - Emmanuel Howo - trip to Kigali"
✓ "Service revenue - RURA - diesel delivery"
✓ "Payment received from Emmanuel Howo"
✓ "Service revenue - Price House - construction materials"

BAD Examples (DO NOT USE):
✗ "Service revenue - customer"
✗ "Service revenue - trip"
✗ "Payment from customer"
✗ "Outstanding balance for customer"

How to extract customer names:
- Direct mention: "Emmanuel owes me 50k" → "Emmanuel"
- Context clues: "delivered to RURA" → "RURA"
- Previous conversation: If customer mentioned earlier, use that name
- If truly unknown, ask: "What is the customer's name?" before recording

ACCOUNTS PAYABLE (AP) - Purchases on Credit:
- When we buy goods/services on credit (NOT paid immediately):
  1) DR Expense Account, CR Accounts Payable (recognize expense, record liability)
  2) Payment method: "Credit" (not Cash!)
- When we later pay the debt:
  1) DR Accounts Payable, CR Cash (reduce liability, pay cash)
  2) Payment method: "Cash"
- Keywords: "on credit", "loan taken", "will pay later", "borrowed"
- WRONG: DR Expense/CR Cash on purchase date (means you paid immediately!)
- CORRECT: DR Expense/CR AP on purchase, DR AP/CR Cash on payment

ADVANCE PAYMENTS - Services/Goods with Partial Payment Upfront:
SCENARIO: Total cost is X, paid Y upfront, will pay remaining (X-Y) later
CRITICAL: Record ONLY the amounts actually transacted, NOT the total!

Example: 90,000 RWF carpet repair, 50,000 paid upfront, 40,000 owed
CORRECT Recording:
1) ADVANCE PAYMENT (when you pay 50,000 upfront):
   DR Vehicle Maintenance Expense 50,000
   CR Cash 50,000
   Description: "Carpet repair - advance payment"
   
2) REMAINING AMOUNT OWED (when work is done, 40,000 still owed):
   DR Vehicle Maintenance Expense 40,000
   CR Accounts Payable 40,000
   Description: "Carpet repair - remaining balance"
   
3) FINAL PAYMENT (when you pay the 40,000):
   DR Accounts Payable 40,000
   CR Cash 40,000
   Description: "Carpet repair - final payment"

WRONG Recording (DO NOT DO THIS):
✗ Recording 90,000 expense when only 50,000 was paid
✗ Recording the full 90,000 as Accounts Payable when 50,000 was already paid
✗ Recording the final 40,000 payment as an expense (it pays off liability!)

Keywords: "paid X upfront", "advance payment", "deposit", "down payment", "will pay remaining later"
Formula: Total Cost = Advance Payment + Remaining Balance
- Step 1: DR Expense (advance amount), CR Cash
- Step 2: DR Expense (remaining amount), CR Accounts Payable  
- Step 3: DR Accounts Payable (remaining amount), CR Cash

IMPORTANT: When the user asks you to "record", "create", "adjust", or "add" a transaction or adjusting entry, you MUST respond with a JSON object.

TRANSACTION DESCRIPTION GUIDELINES - CRITICAL:
Write clean, simple transaction descriptions that anyone can understand:
- Keep descriptions SHORT (5-10 words maximum)
- Use everyday language - describe what actually happened
- NO calculations, explanations, or technical notes in descriptions
- Focus on WHO, WHAT, WHERE (if relevant)

GOOD Examples:
✓ "Sold 10kg rice to Green Lounge"
✓ "Diesel purchase - 50 liters"
✓ "Vehicle repair - thermostat"
✓ "Driver payment - 3 trips"
✓ "Received payment from RURA"
✓ "Paid salary to fleet manager"

BAD Examples (DO NOT USE):
✗ "Driver income: 3 trips (95,000 + 30,000 + other trips) totaling 315,000 RWF"
✗ "Payment for fixing (related to) diesel. (Note: 'pine' is defined as 'diesel'...)"
✗ Any description with calculations, parentheses, or technical explanations

DELETE TRANSACTIONS - YOU CANNOT DELETE:
When user asks to delete a transaction, respond simply:

"I can't delete transactions, but I can help fix them. Would you like me to:
- Create a reversing entry (cancels out the wrong transaction)
- Record an adjustment for the correct amount

Or you can delete it manually in the Journal section."
4. Confirm the deletion (you'll be asked twice to confirm)

Would you like me to create an adjusting entry instead?"

NEVER respond with delete_transaction action - you do not have permission to delete.

**CRITICAL JSON RESPONSE FORMAT:**
When recording transactions or adding inventory items, respond with PURE JSON ONLY - NO text before or after!

❌ WRONG (DO NOT DO THIS):
"Recorded a transfer...

\`\`\`json
{ "action": "create_transaction", ... }
\`\`\`"

✅ CORRECT:
{ "action": "create_transaction", ... }

For transaction/adjusting entry requests, respond ONLY with this JSON format (zero explanatory text, pure JSON):
{
  "action": "create_transaction",
  "transactions": [
    {
      "description": "detailed description",
      "amount": number,
      "date": "YYYY-MM-DD",
      "debitAccount": "Account Name",
      "creditAccount": "Account Name",
      "type": "income" | "expense" | "adjustment"
    }
  ],
  "message": "Clean, user-friendly confirmation message WITHOUT showing any JSON code"
}

CRITICAL: Your "message" field should be simple, direct, and conversational:

✅ GOOD - Direct and clear:
- "Recorded sale of 10kg rice to Green Lounge (20,000 RWF). Stock: 50kg → 40kg."
- "Recorded diesel purchase - 50 liters for 75,000 RWF. Stock: 100 → 150 liters."
- "Recorded payment to driver for 3 trips (60,000 RWF)."
- "Recorded. RURA owes you 100,000 RWF for diesel delivery."

❌ BAD - Too technical or wordy:
- "Recorded 1 transaction for 2026-01-28 with debit to Cash account..."
- "Successfully created a double-entry journal entry..."
- "Transaction recorded: DR Cash 20,000 / CR Sales Revenue 20,000"

NEVER:
- Include JSON code blocks or code markers
- Use accounting jargon (debit/credit, COGS, A/R, etc.)
- Show technical details unless user specifically asks
- Write long explanations when recording is complete

ADJUSTING ENTRIES - You can create any debit/credit pair by specifying account names:
- Depreciation: DR "Depreciation Expense", CR "Accumulated Depreciation"
- Accrued Expense: DR "Expense Account", CR "Accrued Expenses Payable"
- Prepaid Expense: DR "Prepaid Expense", CR "Cash" (when paid), then later DR "Expense", CR "Prepaid Expense"
- Unearned Revenue: DR "Cash", CR "Unearned Revenue" (when received), then later DR "Unearned Revenue", CR "Revenue"
- Accrued Revenue: DR "Accounts Receivable", CR "Revenue"

Examples:
User: "record depreciation of 50,000 for this month"
{
  "action": "create_transaction",
  "transactions": [{
    "description": "Monthly depreciation expense",
    "amount": 50000,
    "date": "2026-01-31",
    "debitAccount": "Depreciation Expense",
    "creditAccount": "Accumulated Depreciation",
    "type": "adjustment"
  }],
  "message": "Recorded monthly depreciation of 50,000 RWF."
}

User: "accrue 30,000 for unpaid wages"
{
  "action": "create_transaction",
  "transactions": [{
    "description": "Accrued wages payable for unpaid work",
    "amount": 30000,
    "date": "2026-01-08",
    "debitAccount": "Wages Expense",
    "creditAccount": "Wages Payable",
    "type": "adjustment"
  }],
  "message": "Accrued 30,000 RWF for wages payable."
}

For simple income/expense (backwards compatible):
- type: "income" means DR Cash, CR Service Revenue (debitAccount/creditAccount optional)
- type: "expense" means DR Expense, CR Cash (debitAccount/creditAccount optional)

TRANSACTION TYPE RULES — CRITICAL:
- Use "expense" for ALL spending (food, wages, rent, fuel, repairs, supplies, transport, etc.)
- Use "income" for ALL revenue (sales, services, payments received)
- Use "adjustment" ONLY for: depreciation, accruals, reversals, prepaid write-offs
- NEVER use "adjustment" for normal business expenses — even if debitAccount + creditAccount are both set
- Always set BOTH debitAccount AND creditAccount for expenses so the right named account is used

EXPENSE ACCOUNT NAMING — always put the specific name in "debitAccount":
- Food ingredients / produce → "Food & Beverage Expense"
- Chef or kitchen staff pay → "Kitchen Wages"
- Waiters / servers pay → "Staff Wages"
- Manager / admin salary → "Staff Wages"
- Rent → "Rent Expense"
- Electricity, water, utilities → "Utilities Expense"
- Fuel / diesel / gas → "Fuel Expense"
- Delivery / transport → "Transport Expense"
- Equipment repair, maintenance → "Maintenance Expense"
- Kitchen/restaurant supplies → "Supplies Expense"
- Marketing / advertising → "Marketing Expense"
- Personal items by the owner → "Personal Expense"
- Anything else → use a clear, descriptive name like "Insurance Expense"

CREDIT ACCOUNT RULES:
- Paid immediately (cash/mobile money) → creditAccount: "Cash"
- Bought on credit / will pay later → creditAccount: "Accounts Payable"

PERSONAL EXPENSE FLAGGING:
- If an expense is clearly personal (personal shopping, meals not for the business, personal fuel):
  → Record normally as type: "expense", debitAccount: "Personal Expense"
  → Add "(personal)" to the description
  → Include a ⚠️ note in your message: "⚠️ This looks like a personal expense — recorded under Personal Expense."

AMBIGUOUS ENTRY FLAGGING:
- If an entry might be a duplicate (e.g., "paid again 3,000", "another payment"):
  → Record it but add "(verify: possible duplicate)" to the description
  → Include a ⚠️ note in your message: "⚠️ This entry looks like it could be a duplicate — please verify."

LARGE PURCHASE / ASSET FLAGGING:
- If a physical item or equipment costs ≥ 500,000 RWF:
  → Record it as normal expense
  → Include a ⚠️ note in your message: "⚠️ This amount may qualify as a fixed asset — consider recording it under a dedicated asset account."

For normal questions (not recording), respond with plain text as usual.

Keep responses concise. Use proper debit/credit format for journal entries.

---

🎯 MARKETING STRATEGIST MODE — JESSE AS A MARKETING BRAIN

When a user asks about marketing, promotions, campaigns, how to get more customers, why sales are dropping, or how to increase revenue/traffic, activate this 5-step marketing strategist framework. NEVER just throw generic ideas — always diagnose first, then prescribe.

**WHEN TO ACTIVATE:** Keywords like "marketing", "promotion", "more customers", "sales are dropping", "slow night", "slow week", "campaign", "how to grow", "attract customers", "increase traffic", "bring people in", "nobody is coming", "quiet today", "boost sales".

---

📋 STEP 1 — EMPATHIZE, DETECT, THEN DIAGNOSE (CRITICAL)

**AUTO-DETECT: DATA MODE vs DISCOVERY MODE**

Before composing your first marketing response, check if RESTAURANT MARKETING DATA is populated in this prompt:

🟢 DATA MODE — recent dish sales data exists (recentTotalRevenue > 0 OR dishPerformance has entries):
   - Open by briefly referencing what you actually found in the data. Be specific and human:
     ✅ "I can see your sales have been down about [X]% compared to last month — that's definitely something we can work on."
     ✅ "Looking at your recent numbers, [top dish] is still performing well but overall revenue has dipped."
   - Then ask ONE diagnostic question to understand context the data can't tell you.
   - Keep the entire opening under 4 lines. Do NOT dump all the data at once.

🔴 DISCOVERY MODE — no sales data yet (recentTotalRevenue = 0 AND dishPerformance is empty):
   - Do NOT say things like "the system shows no data" or "I cannot analyze". That sounds robotic.
   - Instead, turn it into a natural conversation opener:
     ✅ "Since your account is still getting started, I'll ask a couple of quick questions to understand your situation."
     ✅ "I don't have enough sales history yet to spot patterns, so let me ask you directly."
   - Then ask Discovery Question 1: "When did you first notice fewer customers coming in?"

**FOR BOTH MODES — response structure:**
1. One warm sentence (empathy, max 1 line)
2. One sentence about what you're doing / what you see in the data (or discovery acknowledgement)
3. ONE question only
4. One forward-looking sentence: "Once I know that, I can suggest some marketing ideas that usually work well in situations like this."

SHORT IS BETTER. Remove any sentence that doesn't add value. "Let's focus on your restaurant business" = cut it. The manager already knows they run a restaurant.

Now analyze the RESTAURANT MARKETING DATA above internally:
- Is revenue trending up or down vs last 30 days?
- Which dishes are declining? Which are growing?
- What time patterns exist?
Then classify the problem into one of these categories (but share this AFTER the conversation, not as a robot dump):

**Problem A — Awareness:** People don't know about the restaurant.
**Problem B — Excitement:** People know it but feel it's boring / nothing new.
**Problem C — Value:** Customers feel it's too expensive.
**Problem D — Experience:** Food, service, speed, or atmosphere issues.
**Problem E — Competition:** New competitors nearby pulling customers away.

When you STATE the problem type, be human about it. Example: "Based on what you're telling me and your numbers, it sounds like a **Problem B** — your regulars know you, but there's nothing new pulling them in right now."

---

📋 STEP 2 — CHOOSE THE MARKETING OBJECTIVE

Once you identify the issue, state the campaign goal:
- Bring NEW customers in
- Bring OLD customers BACK
- Increase visit FREQUENCY
- Increase average ORDER VALUE
- Promote a specific dish
- Fill a slow time slot (lunch, weekday evenings, etc.)

---

📋 STEP 3 — SELECT THE RIGHT CAMPAIGN TYPE

Choose from these campaign types based on the problem:

🔁 **Campaign Type 1: "Come Back" Campaign** (for repeat/lapsed customers)
Goal: Bring old customers back.
Ideas: "We miss you" discount, loyalty reward, SMS to customers who haven't visited in 30+ days.
Example output: "Send a 20% discount to customers who haven't visited in 30 days."

💥 **Campaign Type 2: Buzz Campaign** (for excitement/awareness)
Goal: Create excitement and word-of-mouth.
Ideas: Limited dish launch, Chef's Special Week, tasting event, mystery menu.
Example output: "Launch a 'Chef's Special Week' with 3 exclusive dishes — promote on Instagram stories."

💰 **Campaign Type 3: Value Campaign** (for price-sensitive customers)
Goal: Attract customers who feel pricing is a barrier.
Ideas: Combo meals, weekday lunch deals, family packages, happy hour pricing.
Example output: "Introduce a weekday lunch combo at 25% lower price — fill those quiet midday tables."

🎉 **Campaign Type 4: Experience Campaign** (for atmosphere/entertainment)
Goal: Give people a REASON to come in beyond just food.
Ideas: Live music night, themed dinner, trivia night, sports viewing night, ladies' night.
Example output: "Host a Friday live music night — charge normal prices but the experience creates traffic."

📱 **Campaign Type 5: Viral Social Campaign** (for online attention)
Goal: Reach new customers through social sharing.
Ideas: Food challenge with a prize, Instagram photo wall, TikTok-worthy dish, staff reel.
Example output: "Create a spicy food challenge — winner eats free. Film it, post it, watch it spread."

---

📋 STEP 4 — GENERATE A FULL CAMPAIGN PLAN

Don't just give ideas — give a COMPLETE, actionable plan. Format it like this:

**Campaign Name:** [Creative name]
**Goal:** [specific objective]
**Strategy:** [2-3 sentence description of the approach]
**Promotion Plan:**
::ArrowRight:: [Action 1 — be specific]
::ArrowRight:: [Action 2]
::ArrowRight:: [Action 3]
**Copy Ideas:**
- Instagram caption: [example text]
- SMS message: [example text — short, under 160 chars]
- In-store: [poster angle or staff script]
**Expected Impact:** [Realistic estimate like "+15-25% weekend traffic"]
**Best Time to Launch:** [Specific day/timing recommendation]

---

📋 STEP 5 — THE MAGIC QUESTION

After every marketing recommendation, always end with the key marketing brain question:

"**Why should someone come to your restaurant TODAY?**"

Help the manager always have an answer to this. If they don't have one, THAT is the problem. Great restaurants always have a reason to visit:
- Taco Tuesday
- Happy Hour (5-7pm)
- Chef's Special
- Live Music Friday
- Family Sunday package

Ask: "What's your current reason for someone to come in THIS week?"
If they say "nothing" — that's the insight. Start there.

---

🖊️ CONTENT GENERATION MODE

If the user asks Jesse to write marketing content, generate it immediately:

- "Write an Instagram caption for my burger special" → Write 2-3 caption options.
- "Write an SMS campaign" → Write a message under 160 characters, punchy and clear.
- "Write a promo for my lunch deal" → Give them copy they can use instantly.
- "Create ad copy" → Write a short, benefit-led ad (headline + 2 lines).

Always match the tone to a casual, friendly restaurant — warm, not corporate. Use the dish names and real details from RESTAURANT MARKETING DATA above when available.

---

📊 CAMPAIGN TRACKING AWARENESS

If the user mentions the result of a past campaign ("the burger night worked", "the discount didn't bring many people"), acknowledge it and store the pattern in your advice:
- Reference what worked: "Since live music boosted traffic last time, double down on that."
- Reference what didn't: "Discounts alone brought limited return — let's try value-add instead."

---

💡 MARKETING INTELLIGENCE RULES:
- Always use REAL DISH NAMES from the user's data when making recommendations (e.g., "Push your [top dish] harder — it's your bestseller.").
- If revenue is declining compared to prior period, OPEN with the trend immediately.
- If a dish has high margin but low orders — flag it as an opportunity: "This dish makes great money but nobody orders it — let's change that."
- If a dish has high orders but low margin — flag it as a risk: "This is popular but barely profitable — can you reduce cost or raise price slightly?"
- NEVER suggest a campaign without tying it to a real problem identified from their data.`

		const conversationText = (conversationHistory || [])
			.map((msg: any) => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
			.join('\n\n')

		const fullPrompt = `${systemContext}\n\nPrevious:\n${conversationText}\n\nUser: ${message}`

		// Prepare image data if images are provided
		let imageParts: any[] = []
		if (images && images.length > 0) {
			console.log(`[AI Chat] Processing ${images.length} image(s):`, images)
			for (const imagePath of images) {
				try {
					// Read image file from public folder
					const filePath = path.join(process.cwd(), 'public', imagePath)
					const buffer = await readFile(filePath)
					const base64 = buffer.toString('base64')
					
					// Determine mime type from file extension
					const ext = path.extname(imagePath).toLowerCase()
					const mimeTypeMap: Record<string, string> = {
						'.png': 'image/png',
						'.jpg': 'image/jpeg',
						'.jpeg': 'image/jpeg',
						'.webp': 'image/webp',
						'.gif': 'image/gif'
					}
					const mimeType = mimeTypeMap[ext] || 'image/jpeg'
					
					console.log(`[AI Chat] Successfully loaded image: ${imagePath} (${mimeType})`)
					
					imageParts.push({
						inlineData: {
							data: base64,
							mimeType: mimeType
						}
					})
				} catch (e) {
					console.error('[AI Chat] Failed to read image:', imagePath, e)
				}
			}
			console.log(`[AI Chat] Prepared ${imageParts.length} image part(s) for AI`)
		}

		const exhaustedKeyIndexes = new Set<number>()
		const keyOnlyQuotaFailures = new Map<number, boolean>(apiKeys.map((_, index) => [index, true]))
		const retryConfig = getGeminiRetryConfig()
		let lastError: any
		for (const attempt of getGeminiAttemptPlan(apiKeys)) {
			if (exhaustedKeyIndexes.has(attempt.keyIndex)) continue

			let parsedResponse: any = null
			let responseText = ''
			let serviceUnavailableRetryCount = 0
			while (true) {
				try {
			console.log(`[AI Chat] Trying model: ${attempt.modelName}${imageParts.length > 0 ? ' (with images)' : ''}`)
			const requestDiagnostics = {
				keyIndex: attempt.keyIndex + 1,
				keyCount: attempt.keyCount,
				modelName: attempt.modelName,
				usedFallbackKey: attempt.usedFallbackKey,
				usedFallbackModel: attempt.usedFallbackModel,
			}
			lastAiDiagnostics = requestDiagnostics
			const genAI = new GoogleGenerativeAI(attempt.apiKey)
			const model = genAI.getGenerativeModel({ model: attempt.modelName })
			
			// If we have images, send them with the prompt
			let result
			if (imageParts.length > 0) {
				result = await model.generateContent([
					{ text: fullPrompt },
					...imageParts
				])
			} else {
				result = await model.generateContent(fullPrompt)
			}
			
			responseText = result.response.text()
			clearGeminiQuotaFailure(attempt.apiKey)
			console.log(`[AI Chat] Model ${attempt.modelName} response length:`, responseText.length)

			// Extract all JSON blocks (supports multi-action AI responses)
			const jsonBlocks = extractAllJsonBlocks(responseText)
			const normalizedJsonBlocks = normalizeAiJsonBlocks(jsonBlocks)
			const aiDiagnostics = {
				...requestDiagnostics,
				rawJsonBlockCount: jsonBlocks.length,
				normalizedBlockCount: normalizedJsonBlocks.length,
				primaryAction: normalizedJsonBlocks[0]?.action ?? null,
			}
			lastAiDiagnostics = aiDiagnostics
			if (jsonBlocks.length === 0) {
				console.log(`[AI Chat] Non-JSON response (conversational message)`)
				console.log(`[AI Chat] Served by key #${aiDiagnostics.keyIndex}/${aiDiagnostics.keyCount} model ${aiDiagnostics.modelName} (fallbackKey=${aiDiagnostics.usedFallbackKey}, fallbackModel=${aiDiagnostics.usedFallbackModel})`)
				return NextResponse.json(buildAiResponsePayload({ response: sanitizeProviderMentions(responseText) }, aiDiagnostics, showAiDiagnostics))
			}
			if (normalizedJsonBlocks.length === 0) {
				console.log(`[AI Chat] JSON response could not be normalized into actions`)
				console.log(`[AI Chat] Served by key #${aiDiagnostics.keyIndex}/${aiDiagnostics.keyCount} model ${aiDiagnostics.modelName} (fallbackKey=${aiDiagnostics.usedFallbackKey}, fallbackModel=${aiDiagnostics.usedFallbackModel})`)
				return NextResponse.json(buildAiResponsePayload({ response: sanitizeProviderMentions(responseText) }, aiDiagnostics, showAiDiagnostics))
			}
			console.log(`[AI Chat] Found ${jsonBlocks.length} raw JSON block(s), normalized to ${normalizedJsonBlocks.length}; primary action: ${normalizedJsonBlocks[0].action}`)
			console.log(`[AI Chat] Served by key #${aiDiagnostics.keyIndex}/${aiDiagnostics.keyCount} model ${aiDiagnostics.modelName} (fallbackKey=${aiDiagnostics.usedFallbackKey}, fallbackModel=${aiDiagnostics.usedFallbackModel})`)
			parsedResponse = normalizedJsonBlocks[0]

			const accumulated = {
				messages: [] as string[],
				transactionsCreated: [] as any[],
				purchaseResults: [] as any[],
				itemsCreated: [] as any[],
				salesResults: [] as any[],
				addAndPurchaseResults: [] as any[]
			}

		for (const block of normalizedJsonBlocks) {
		parsedResponse = block

		// If it's a delete transaction request - AI cannot delete
		if (parsedResponse.action === 'delete_transaction') {
			accumulated.messages.push('I cannot delete transactions. Please use the Delete button in the Journal section of the dashboard, or ask me to create an adjusting entry to reverse the transaction.')
			continue
		}

		// If it's a transaction creation request
		if (parsedResponse.action === 'create_transaction' && parsedResponse.transactions) {
			const userId = billingUserId
			const createdTransactions = []

			// Get necessary accounts and categories
			const assetCategory = await ensureCategoryByType('asset', 'Asset', restaurantId)
			const incomeCategory = await ensureCategoryByType('income', 'Income', restaurantId)
			const expenseCategory = await ensureCategoryByType('expense', 'Expense', restaurantId)

			const cashAccount = await ensureNamedAccount('Cash', 'asset', assetCategory.id, 'AST-CASH', restaurantId)
			if (!cashAccount) throw new Error('Cash account not found')

			for (const txn of parsedResponse.transactions) {
					const amount = typeof txn.amount === 'number' ? txn.amount : parseFloat(String(txn.amount).replace(/[^0-9.]/g, ''))
					if (!amount || amount <= 0) continue

					const date = resolveActionDate(txn.date, message)
					const description = txn.description || 'Transaction from AI Chat'
					const pairId = `pair-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`

					// Handle adjusting entries with custom debit/credit accounts
					if (txn.type === 'adjustment') {
						// Get or create debit account
						const debitAccountName = txn.debitAccount || 'General Expense'
						let debitAccount = await findScopedAccountByName(debitAccountName, restaurantId)
						
						if (!debitAccount) {
							// Auto-determine account type and category
							const isExpense = debitAccountName.toLowerCase().includes('expense') || debitAccountName.toLowerCase().includes('depreciation')
							const isAsset = debitAccountName.toLowerCase().includes('receivable') || debitAccountName.toLowerCase().includes('prepaid')
							const category = isExpense ? expenseCategory : isAsset ? assetCategory : expenseCategory
							
							if (category) {
								debitAccount = await prisma.account.create({
									data: {
										restaurantId,
										code: `AUTO-${Date.now().toString(36).toUpperCase()}`,
										name: debitAccountName,
										type: isExpense ? 'expense' : isAsset ? 'asset' : 'expense',
										categoryId: category.id
									}
								})
							}
						}

						// Get or create credit account
						const creditAccountName = txn.creditAccount || 'Cash'
						let creditAccount = await findScopedAccountByName(creditAccountName, restaurantId)
						
						if (!creditAccount) {
							// Auto-determine account type and category
							const isRevenue = creditAccountName.toLowerCase().includes('revenue') || creditAccountName.toLowerCase().includes('income')
							const isLiability = creditAccountName.toLowerCase().includes('payable') || creditAccountName.toLowerCase().includes('unearned')
							const isContraAsset = creditAccountName.toLowerCase().includes('accumulated')
							
							let category
							let accountType
							
							if (isRevenue) {
								category = incomeCategory
								accountType = 'revenue'
							} else if (isLiability) {
								category = await ensureCategoryByType('liability', 'Liability', restaurantId)
								accountType = 'liability'
							} else if (isContraAsset) {
								category = assetCategory
								accountType = 'asset'
							} else {
								category = assetCategory
								accountType = 'asset'
							}
							
							if (category) {
								creditAccount = await prisma.account.create({
									data: {
										restaurantId,
										code: `AUTO-${Date.now().toString(36).toUpperCase()}`,
										name: creditAccountName,
										type: accountType,
										categoryId: category.id
									}
								})
							}
						}

						if (debitAccount && creditAccount) {
							await createJournalPair({
								userId,
								restaurantId,
								date,
								description,
								amount,
								paymentMethod: 'Adjustment',
								debitAccountId: debitAccount.id,
								debitCategoryId: debitAccount.categoryId,
								creditAccountId: creditAccount.id,
								creditCategoryId: creditAccount.categoryId,
								sourceKind: 'ai_adjustment',
								authoritativeForRevenue: false,
								pairId,
							})
							createdTransactions.push({ 
								amount, 
								description, 
								type: 'adjustment',
								entry: `DR ${debitAccountName} / CR ${creditAccountName}`
							})
						}
					} else if (txn.type === 'income') {
						// Income: DR Cash, CR Service Revenue
						let serviceRevenueAccount = await findScopedAccountByName('Service Revenue', restaurantId)
						if (!serviceRevenueAccount && incomeCategory) {
							serviceRevenueAccount = await prisma.account.create({
								data: {
									restaurantId,
									code: 'REV-001',
									name: 'Service Revenue',
									type: 'revenue',
									categoryId: incomeCategory.id
								}
							})
						}

						if (serviceRevenueAccount) {
							await createJournalPair({
								userId,
								restaurantId,
								date,
								description,
								amount,
								paymentMethod: 'Cash',
								debitAccountId: cashAccount.id,
								debitCategoryId: cashAccount.categoryId,
								creditAccountId: serviceRevenueAccount.id,
								creditCategoryId: serviceRevenueAccount.categoryId,
								sourceKind: 'ai_income',
								authoritativeForRevenue: true,
								pairId,
							})
							createdTransactions.push({ amount, description, type: 'income' })
						}
					} else if (txn.type === 'expense') {
						// Expense: DR specific expense account, CR specific credit account (Cash or AP)
						const expenseAccountName = txn.debitAccount || 'General Expense'
						let expenseAccount = await findScopedAccountByName(expenseAccountName, restaurantId)
						if (!expenseAccount && expenseCategory) {
							expenseAccount = await prisma.account.create({
								data: {
									restaurantId,
									code: `EXP-${Date.now().toString(36).toUpperCase()}`,
									name: expenseAccountName,
									type: 'expense',
									categoryId: expenseCategory.id
								}
							})
						}

						// Determine credit account (Cash by default, or named account like Accounts Payable)
						const expenseCreditName = txn.creditAccount || 'Cash'
						let expenseCreditAccount = expenseCreditName === 'Cash'
							? cashAccount
							: await findScopedAccountByName(expenseCreditName, restaurantId)

						if (!expenseCreditAccount && expenseCreditName !== 'Cash') {
							const isLiability = expenseCreditName.toLowerCase().includes('payable')
							const liabilityCat = await ensureCategoryByType('liability', 'Liability', restaurantId)
							const creditCat = isLiability ? liabilityCat : assetCategory
							if (creditCat) {
								expenseCreditAccount = await prisma.account.create({
									data: {
										restaurantId,
										code: `AUTO-${Date.now().toString(36).toUpperCase()}`,
										name: expenseCreditName,
										type: isLiability ? 'liability' : 'asset',
										categoryId: creditCat.id
									}
								})
							}
						}
						if (!expenseCreditAccount) expenseCreditAccount = cashAccount

						const expensePaymentMethod = expenseCreditName.toLowerCase().includes('payable') ? 'Credit' : 'Cash'

						if (expenseAccount && expenseCreditAccount) {
							await createJournalPair({
								userId,
								restaurantId,
								date,
								description,
								amount,
								paymentMethod: expensePaymentMethod,
								debitAccountId: expenseAccount.id,
								debitCategoryId: expenseAccount.categoryId,
								creditAccountId: expenseCreditAccount.id,
								creditCategoryId: expenseCreditAccount.categoryId,
								sourceKind: 'ai_expense',
								authoritativeForRevenue: false,
								pairId,
							})
							createdTransactions.push({ amount, description, type: 'expense' })
						}
					}
				}

				if (parsedResponse.message) accumulated.messages.push(parsedResponse.message)
					else accumulated.messages.push('Transaction(s) recorded successfully!')
					accumulated.transactionsCreated.push(...createdTransactions)
					continue
				}

				// If it's an inventory management request
				if (parsedResponse.action === 'add_inventory' && parsedResponse.items) {
					const userId = billingUserId
					const createdItems = []
					const inventoryMessages: string[] = []

					for (const item of parsedResponse.items) {
						if (!item.name || !item.unit) continue
						const inventoryDate = resolveInventoryEntryDate(parsedResponse.date, (item as any).purchasedAt ?? (item as any).date, message)
						const requestedQuantity = Number(item.quantity ?? 0)
						const hasRequestedQuantity = Number.isFinite(requestedQuantity) && requestedQuantity > 0
						const resolvedUnitPrice = item.unitPrice !== undefined && item.unitPrice !== null ? Number(item.unitPrice) : null
						const hasUnitPrice = Number.isFinite(resolvedUnitPrice) && Number(resolvedUnitPrice) > 0
						const purchaseSupplier = (item as any).supplier || parsedResponse.supplier || 'Opening Stock'

						// Case-insensitive lookup compatible with SQLite
						const existingItem = await findInventoryItemByName(userId, restaurantId, item.name)

						if (existingItem) {
							const existingPurchaseCount = await prisma.inventoryPurchase.count({
								where: { userId, ingredientId: (existingItem as any).id, ...restaurantReadScope }
							})
							const canSeedOpeningStock = hasRequestedQuantity && hasUnitPrice && existingPurchaseCount === 0
							const nextQuantity = canSeedOpeningStock ? requestedQuantity : (existingItem as any).quantity

							// Update existing item — write to unitCost, set inventoryType ingredient
							const updatedItem = await prisma.inventoryItem.update({
								where: { id: (existingItem as any).id },
								data: {
									unit: item.unit,
									unitCost: item.unitPrice !== undefined ? (item.unitPrice || null) : (existingItem as any).unitCost,
									quantity: nextQuantity,
									category: item.category || (existingItem as any).category,
									inventoryType: 'ingredient',
									...(canSeedOpeningStock ? { lastRestockedAt: inventoryDate } : {})
								} as any
							})
							if (canSeedOpeningStock) {
								await createInventoryPurchaseBatch({
									userId,
									restaurantId,
									ingredientId: updatedItem.id,
									quantity: requestedQuantity,
									unitCost: resolvedUnitPrice,
									totalCost: requestedQuantity * Number(resolvedUnitPrice),
									purchasedAt: inventoryDate,
									supplier: purchaseSupplier,
								})
							} else if (hasRequestedQuantity && existingPurchaseCount > 0) {
								inventoryMessages.push(`Kept existing batch quantities for ${updatedItem.name}; use a purchase action to add more stock instead of resetting the item quantity.`)
							} else if (hasRequestedQuantity && !hasUnitPrice) {
								inventoryMessages.push(`Added ${updatedItem.name} without opening stock because no unit cost was provided.`)
							}
							createdItems.push({ name: updatedItem.name, updated: true, unitPrice: item.unitPrice || 0, quantity: nextQuantity || 0, unit: item.unit })
						} else {
							const openingQuantity = hasRequestedQuantity && hasUnitPrice ? requestedQuantity : 0

							// Create new item — always ingredient type, always unitCost
							const newItem = await prisma.inventoryItem.create({
								data: {
									userId,
									restaurantId,
									name: item.name,
									unit: item.unit,
									unitCost: item.unitPrice || null,
									quantity: openingQuantity,
									category: item.category || null,
									inventoryType: 'ingredient',
									...(openingQuantity > 0 ? { lastRestockedAt: inventoryDate } : {})
								} as any
							})
							if (openingQuantity > 0) {
								await createInventoryPurchaseBatch({
									userId,
									restaurantId,
									ingredientId: newItem.id,
									quantity: openingQuantity,
									unitCost: resolvedUnitPrice,
									totalCost: openingQuantity * Number(resolvedUnitPrice),
									purchasedAt: inventoryDate,
									supplier: purchaseSupplier,
								})
							} else if (hasRequestedQuantity) {
								inventoryMessages.push(`Added ${newItem.name} to inventory without opening stock because no unit cost was provided.`)
							}
							createdItems.push({ name: newItem.name, updated: false, unitPrice: item.unitPrice || 0, quantity: openingQuantity || 0, unit: item.unit })
						}
					}

				if (parsedResponse.message) accumulated.messages.push(parsedResponse.message)
					else accumulated.messages.push('Inventory item(s) added successfully!')
					if (inventoryMessages.length > 0) accumulated.messages.push(inventoryMessages.join(' '))
					accumulated.itemsCreated.push(...createdItems)
					continue
				}

				// If it's an inventory sale request with tracking
				if (parsedResponse.action === 'record_sale' && parsedResponse.items) {
					const userId = billingUserId
					const salesResults = []
					const createdTransactions = []

					// Get or create Sales Revenue account
					const incomeCategory = await ensureCategoryByType('income', 'Income', restaurantId)
					const assetCategory = await ensureCategoryByType('asset', 'Asset', restaurantId)
					const cashAccount = await ensureNamedAccount('Cash', 'asset', assetCategory.id, 'AST-CASH', restaurantId)
					const arAccount = await ensureNamedAccount('Accounts Receivable', 'asset', assetCategory.id, 'AST-AR', restaurantId)
					
					let salesRevenueAccount = await findScopedAccountByName('Sales Revenue', restaurantId)
					if (!salesRevenueAccount && incomeCategory) {
						salesRevenueAccount = await prisma.account.create({
							data: {
								restaurantId,
								code: 'REV-002',
								name: 'Sales Revenue',
								type: 'revenue',
								categoryId: incomeCategory.id
							}
						})
					}

					const paymentMethod = parsedResponse.paymentMethod || 'Cash'
					const saleDate = resolveActionDate(parsedResponse.date, message)

					for (const item of parsedResponse.items) {
						// Case-insensitive lookup compatible with SQLite
						let inventoryItem: any = await findInventoryItemByName(userId, restaurantId, item.name)

						if (!inventoryItem) {
							salesResults.push({ name: item.name, error: `Item not found in inventory. Please add it first.` })
							continue
						}

// Calculate sale amount — use unitCost as selling price reference
					const quantity = item.quantity || 0
					const unitPrice = item.unitPrice || inventoryItem.unitCost
					if (!unitPrice) {
							salesResults.push({ 
								name: item.name, 
								error: `No price set. Please provide a price or update inventory.` 
							})
							continue
						}

						const totalAmount = quantity * unitPrice
						const pairId = `pair-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`

						// Create transaction entry
						const debitAccount = paymentMethod === 'Credit' ? arAccount : cashAccount
						if (!debitAccount || !salesRevenueAccount) continue

						const customerName = item.customerName || ''
						const description = customerName 
							? `Sale of ${quantity} ${inventoryItem.unit} ${inventoryItem.name} to ${customerName}`
							: `Sale of ${quantity} ${inventoryItem.unit} ${inventoryItem.name}`

						await createJournalPair({
							userId,
							restaurantId,
							date: saleDate,
							description,
							amount: totalAmount,
							paymentMethod,
							debitAccountId: debitAccount.id,
							debitCategoryId: debitAccount.categoryId,
							creditAccountId: salesRevenueAccount.id,
							creditCategoryId: salesRevenueAccount.categoryId,
							sourceKind: 'ai_inventory_sale',
							authoritativeForRevenue: true,
							pairId,
						})

// Update inventory quantity (DEDUCT sold amount)
					const newQuantity = inventoryItem.quantity - quantity
					await prisma.inventoryItem.update({
							where: { id: inventoryItem.id },
							data: { quantity: newQuantity }
						})

						salesResults.push({
							name: inventoryItem.name,
							quantity,
							unit: inventoryItem.unit,
							totalAmount,
							oldQuantity: inventoryItem.quantity,
							newQuantity,
							customerName: customerName || null
						})

						createdTransactions.push({
							amount: totalAmount,
							description,
							type: 'sale'
						})
					}

				if (parsedResponse.message) accumulated.messages.push(parsedResponse.message)
					else accumulated.messages.push('Sale(s) recorded successfully!')
					accumulated.salesResults.push(...salesResults)
					accumulated.transactionsCreated.push(...createdTransactions)
					continue
				}

				// If it's an inventory purchase request
				if (parsedResponse.action === 'record_purchase' && parsedResponse.items) {
					const userId = billingUserId
					const purchaseResults = []
					const createdTransactions = []

					// Get or create necessary accounts
					const expenseCategory = await ensureCategoryByType('expense', 'Expense', restaurantId)

					const inventoryExpenseAccount = await ensureNamedAccount('Inventory Purchase', 'expense', expenseCategory.id, 'EXP-INV', restaurantId)

					const settlement = await resolveSettlementAccount(parsedResponse.paymentMethod, restaurantId)
					const paymentMethod = settlement.paymentMethod

					for (const item of parsedResponse.items) {
						const purchaseDate = resolveInventoryEntryDate(parsedResponse.date, (item as any).purchasedAt ?? (item as any).date, message)
						// Case-insensitive lookup compatible with SQLite
						let inventoryItem: any = await findInventoryItemByName(userId, restaurantId, item.name)

						if (!inventoryItem) {
							// Item not yet in inventory — auto-create it so the purchase can still be recorded
							const unit = (item as any).unit || 'unit'
							const unitPrice = item.unitPrice ?? (item.totalCost && item.quantity && item.quantity > 0 ? item.totalCost / item.quantity : null)
							try {
								inventoryItem = await prisma.inventoryItem.create({
									data: {
										userId,
										restaurantId,
										name: item.name,
										unit,
										unitCost: unitPrice,
										quantity: 0,
										inventoryType: 'ingredient'
									} as any
								})
							} catch (_createErr) {
								purchaseResults.push({ name: item.name, error: `Item not found in inventory and could not be created.` })
								continue
							}
						}

						const quantity = item.quantity || 0
						const totalCost = item.totalCost || (item.unitPrice ? item.unitPrice * quantity : 0)

						if (!totalCost || totalCost <= 0) {
							purchaseResults.push({ name: item.name, error: `No cost provided. Please specify totalCost or unitPrice.` })
							continue
						}

						const pairId = `pair-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
						const description = `Purchase of ${quantity} ${inventoryItem.unit} ${inventoryItem.name}`

						// Create transaction entry
						const creditAccount = settlement.account
						if (!creditAccount || !inventoryExpenseAccount) continue

						await createJournalPair({
							userId,
							restaurantId,
							date: purchaseDate,
							description,
							amount: totalCost,
							paymentMethod,
							debitAccountId: inventoryExpenseAccount.id,
							debitCategoryId: inventoryExpenseAccount.categoryId,
							creditAccountId: creditAccount.id,
							creditCategoryId: creditAccount.categoryId,
							sourceKind: 'inventory_purchase',
							authoritativeForRevenue: false,
							pairId,
						})
						await createInventoryPurchaseBatch({
							userId,
							restaurantId,
							ingredientId: inventoryItem.id,
							quantity,
							unitCost: item.unitPrice ?? inventoryItem.unitCost ?? (quantity > 0 ? totalCost / quantity : null),
							totalCost,
							purchasedAt: purchaseDate,
							journalPairId: pairId,
							supplier: (item as any).supplier || parsedResponse.supplier || 'AI Purchase'
						})

// Update inventory quantity (ADD purchased amount) and refresh unitCost
					const newQuantity = inventoryItem.quantity + quantity
					await prisma.inventoryItem.update({
						where: { id: inventoryItem.id },
						data: { 
							quantity: newQuantity,
							...(item.unitPrice ? { unitCost: item.unitPrice } : {}),
							lastRestockedAt: purchaseDate
						}
						})

						purchaseResults.push({
							name: inventoryItem.name,
							quantity,
							unit: inventoryItem.unit,
							totalCost,
							oldQuantity: inventoryItem.quantity,
							newQuantity
						})

						createdTransactions.push({
							amount: totalCost,
							description,
							type: 'purchase'
						})
					}

				if (parsedResponse.message) accumulated.messages.push(parsedResponse.message)
					else accumulated.messages.push('Purchase(s) recorded successfully!')
					accumulated.purchaseResults.push(...purchaseResults)
					accumulated.transactionsCreated.push(...createdTransactions)
					continue
				}

				// NEW: add_and_purchase — creates new inventory item AND records purchase transaction
				if (parsedResponse.action === 'add_and_purchase' && parsedResponse.items) {
					const userId = billingUserId
					const aapResults: any[] = []

					const aapExpenseCat = await ensureCategoryByType('expense', 'Expense', restaurantId)
					const aapInvExpense = await ensureNamedAccount('Inventory Purchase', 'expense', aapExpenseCat.id, 'EXP-INV', restaurantId)

					const aapSettlement = await resolveSettlementAccount(parsedResponse.paymentMethod, restaurantId)
					const aapPayMethod = aapSettlement.paymentMethod

					for (const item of parsedResponse.items) {
						if (!item.name) continue
						const aapDate = resolveInventoryEntryDate(parsedResponse.date, (item as any).purchasedAt ?? (item as any).date, message)
						const unit = item.unit || 'kg'
						const unitCost = item.unitPrice || null
						const qty = item.quantity || 0
						const totalCost = item.totalCost || (unitCost ? unitCost * qty : 0)

					// Case-insensitive upsert lookup compatible with SQLite
					let invItem: any = await findInventoryItemByName(userId, restaurantId, item.name)
					if (invItem) {
						invItem = await prisma.inventoryItem.update({
							where: { id: invItem.id },
								data: { quantity: invItem.quantity + qty, unitCost: unitCost || invItem.unitCost, inventoryType: 'ingredient', ...(qty > 0 ? { lastRestockedAt: aapDate } : {}) } as any
						})
					} else {
						invItem = await prisma.inventoryItem.create({
								data: { userId, restaurantId, name: item.name, unit, unitCost, quantity: qty, inventoryType: 'ingredient', ...(qty > 0 ? { lastRestockedAt: aapDate } : {}) } as any
							})
						}

						// Record purchase transaction if cost is known
						let pairId: string | null = null
						if (totalCost > 0) {
							const creditAcct = aapSettlement.account
							pairId = `pair-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
							if (creditAcct) {
								await createJournalPair({
									userId,
									restaurantId,
									date: aapDate,
									description: `Purchase of ${qty} ${unit} ${item.name}`,
									amount: totalCost,
									paymentMethod: aapPayMethod,
									debitAccountId: aapInvExpense.id,
									debitCategoryId: aapInvExpense.categoryId,
									creditAccountId: creditAcct.id,
									creditCategoryId: creditAcct.categoryId,
									sourceKind: 'inventory_purchase',
									authoritativeForRevenue: false,
									pairId,
								})
								accumulated.transactionsCreated.push({ amount: totalCost, description: `Purchase of ${qty} ${unit} ${item.name}`, type: 'purchase' })
							}
						}
						await createInventoryPurchaseBatch({
							userId,
							restaurantId,
							ingredientId: invItem.id,
							quantity: qty,
							unitCost: unitCost ?? (qty > 0 ? totalCost / qty : null),
							totalCost,
							purchasedAt: aapDate,
							journalPairId: pairId,
							supplier: (item as any).supplier || parsedResponse.supplier || 'AI Purchase'
						})

						aapResults.push({ name: item.name, quantity: qty, unit, totalCost, newQuantity: invItem.quantity })
					}

					if (parsedResponse.message) accumulated.messages.push(parsedResponse.message)
					else accumulated.messages.push(`Added and recorded purchase for ${aapResults.length} item(s).`)
					accumulated.addAndPurchaseResults.push(...aapResults)
					continue
				}

				// Unrecognized action — capture message if present
				if (parsedResponse.message) accumulated.messages.push(parsedResponse.message)
		} // end for (const block of jsonBlocks)

		// Return accumulated results from all processed blocks
		return NextResponse.json(buildAiResponsePayload({
			response: accumulated.messages.join('\n\n') || sanitizeProviderMentions(responseText),
			...(accumulated.transactionsCreated.length && { transactionsCreated: accumulated.transactionsCreated }),
			...(accumulated.purchaseResults.length && { purchaseResults: accumulated.purchaseResults }),
			...(accumulated.itemsCreated.length && { itemsCreated: accumulated.itemsCreated }),
			...(accumulated.salesResults.length && { salesResults: accumulated.salesResults }),
			...(accumulated.addAndPurchaseResults.length && { addAndPurchaseResults: accumulated.addAndPurchaseResults }),
		}, aiDiagnostics, showAiDiagnostics))
					} catch (e: any) {
						console.error(`[AI Chat] Error with model ${attempt.modelName}:`, e?.message || e, 'status:', e?.status, 'statusText:', e?.statusText, 'errorDetails:', JSON.stringify(e?.error || e?.body || '').slice(0, 500))
						lastError = e
						// If we successfully parsed an action but database operation failed, don't try other models
						if (parsedResponse && parsedResponse.action) {
							console.error(`[AI Chat] Database error while processing action "${parsedResponse.action}":`, e)
							throw e
						}
						if (isQuotaError(e)) {
							markGeminiQuotaFailure(attempt.apiKey, e)
							exhaustedKeyIndexes.add(attempt.keyIndex)
							break
						}
						keyOnlyQuotaFailures.set(attempt.keyIndex, false)
						if (isRetryableGeminiServiceError(e)) {
							if (serviceUnavailableRetryCount < retryConfig.serviceUnavailableRetries) {
								serviceUnavailableRetryCount++
								console.warn(`[AI Chat] Retrying model ${attempt.modelName} after service-unavailable response (${serviceUnavailableRetryCount}/${retryConfig.serviceUnavailableRetries})`)
								await delay(retryConfig.serviceUnavailableDelayMs)
								continue
							}
						}
						break
					}
				}
		}

		const quotaExhaustedCount = exhaustedKeyIndexes.size
		const allKeysQuotaExhausted =
			keyAvailability.blockedKeyCount + quotaExhaustedCount === apiKeys.length &&
			apiKeys.every((_, index) => keyOnlyQuotaFailures.get(index) === true)

		if (allKeysQuotaExhausted) throw new Error('GEMINI_DAILY_LIMIT_REACHED')
	throw lastError || new Error('All configured AI attempts failed')
} catch (e: any) {
	
	// If the error contains validation or missing field information, pass it through
	const errorMessage = e?.message || ''
	if (errorMessage.includes('GEMINI_DAILY_LIMIT_REACHED')) {
		return NextResponse.json(buildAiResponsePayload({
			response: getGeminiUnavailableMessage('Jesse AI')
		}, lastAiDiagnostics ? { ...lastAiDiagnostics, quotaExhausted: true } : null, showAiDiagnostics), { status: 200 })
	}
	if (errorMessage.includes('required') || 
	    errorMessage.includes('missing') || 
	    errorMessage.includes('need') ||
	    errorMessage.includes('must provide') ||
	    errorMessage.includes('invalid')) {
		return NextResponse.json(buildAiResponsePayload({ 
			response: errorMessage
		}, lastAiDiagnostics, showAiDiagnostics), { status: 200 })
	}
	
	// For other errors, return a friendly generic message
	return NextResponse.json(buildAiResponsePayload({ 
		response: "I encountered an issue processing your request. Could you please try rephrasing your question or provide more details?" 
	}, lastAiDiagnostics, showAiDiagnostics), { status: 200 })
}
}
