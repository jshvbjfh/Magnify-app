import type { Prisma, PrismaClient } from '@prisma/client'

type PrismaDb = PrismaClient | Prisma.TransactionClient

type CategoryRecord = { id: string; type: string; name: string }

type CategoryMap = Record<string, CategoryRecord>

function isCashEquivalentAccountName(name?: string) {
	const normalized = (name || '').trim().toLowerCase()
	return normalized === 'cash'
		|| normalized.includes('cash')
		|| normalized === 'current account'
		|| normalized.includes('bank')
		|| normalized === 'mobile money'
		|| normalized.includes('momo')
}

function resolveAccountType(categoryType: string) {
	if (categoryType === 'income') return 'revenue'
	if (categoryType === 'expense') return 'expense'
	return categoryType
}

function makeAutoCode(prefix: string) {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase()
}

export function normalizePaymentMethod(paymentMethod?: string): string {
	const raw = String(paymentMethod || 'Cash').trim().toLowerCase()
	if (raw.includes('internal')) return 'Internal'
	if (raw.includes('note')) return 'Notes Payable'
	if (raw === 'credit' || raw.includes('accounts payable') || raw.includes('payable')) return 'Credit'
	if (raw.includes('mobile') || raw.includes('momo')) return raw.includes('owner') ? 'Owner Momo' : 'Mobile Money'
	if (raw.includes('bank') || raw.includes('transfer') || raw.includes('current account')) return 'Bank'
	return 'Cash'
}

export async function ensureCoreCategories(db: PrismaDb, restaurantId: string | null = null) {
	const types = ['income', 'expense', 'asset', 'liability', 'equity'] as const
	const byType: CategoryMap = {}

	for (const type of types) {
		const name = type.charAt(0).toUpperCase() + type.slice(1)
		const category = await db.category.upsert({
			where: { restaurantId_name: { restaurantId, name } },
			update: { type },
			create: { restaurantId, name, type },
		})
		byType[type] = category
	}

	return byType
}

export async function ensureAccount(db: PrismaDb, params: { restaurantId?: string | null; name: string; type: string; categoryId: string; code?: string }) {
	const restaurantId = params.restaurantId ?? null
	const existing = await db.account.findFirst({ where: { restaurantId, name: params.name } })
	if (existing) return existing

	return db.account.create({
		data: {
			restaurantId,
			code: params.code || makeAutoCode('AUTO'),
			name: params.name,
			type: params.type,
			categoryId: params.categoryId,
		},
	})
}

export async function resolveSettlementAccount(db: PrismaDb, paymentMethod: string, direction: 'in' | 'out', categories: CategoryMap, restaurantId: string | null = null) {
	const normalizedPaymentMethod = normalizePaymentMethod(paymentMethod)

	if (normalizedPaymentMethod === 'Internal') {
		throw new Error('Internal journal entries require an explicit counter account')
	}

	if (direction === 'out') {
		if (normalizedPaymentMethod === 'Credit') {
			return {
				paymentMethod: normalizedPaymentMethod,
				account: await ensureAccount(db, { restaurantId, name: 'Accounts Payable', type: 'liability', categoryId: categories.liability.id, code: '2000' }),
			}
		}
		if (normalizedPaymentMethod === 'Notes Payable') {
			return {
				paymentMethod: normalizedPaymentMethod,
				account: await ensureAccount(db, { restaurantId, name: 'Notes Payable', type: 'liability', categoryId: categories.liability.id, code: '2100' }),
			}
		}
	}

	if (direction === 'in' && normalizedPaymentMethod === 'Credit') {
		return {
			paymentMethod: normalizedPaymentMethod,
			account: await ensureAccount(db, { restaurantId, name: 'Accounts Receivable', type: 'asset', categoryId: categories.asset.id, code: '1200' }),
		}
	}

	if (normalizedPaymentMethod === 'Bank') {
		return {
			paymentMethod: normalizedPaymentMethod,
			account: await ensureAccount(db, { restaurantId, name: 'Current Account', type: 'asset', categoryId: categories.asset.id, code: '1010' }),
		}
	}

	if (normalizedPaymentMethod === 'Mobile Money') {
		return {
			paymentMethod: normalizedPaymentMethod,
			account: await ensureAccount(db, { restaurantId, name: 'Mobile Money', type: 'asset', categoryId: categories.asset.id, code: '1020' }),
		}
	}

	if (normalizedPaymentMethod === 'Owner Momo') {
		return {
			paymentMethod: normalizedPaymentMethod,
			account: await ensureAccount(db, { restaurantId, name: 'Owner Momo', type: 'asset', categoryId: categories.asset.id, code: '1021' }),
		}
	}

	return {
		paymentMethod: 'Cash',
		account: await ensureAccount(db, { restaurantId, name: 'Cash', type: 'asset', categoryId: categories.asset.id, code: '1000' }),
	}
}

export async function recordJournalEntry(db: PrismaDb, params: {
	userId: string
	restaurantId?: string | null
	branchId?: string | null
	date: Date
	description: string
	amount: number
	direction: 'in' | 'out'
	accountName?: string
	categoryType?: string
	paymentMethod?: string
	counterAccountName?: string
	counterCategoryType?: string
	counterAccountType?: string
	isManual?: boolean
	sourceKind?: string
	authoritativeForRevenue?: boolean
}) {
	const restaurantId = params.restaurantId ?? null
	const direction = params.direction
	const categoryType = params.categoryType || (direction === 'out' ? 'expense' : 'income')
	const categories = await ensureCoreCategories(db, restaurantId)

	const mainCategory = categories[categoryType] || categories.expense
	const mainAccountType = resolveAccountType(mainCategory.type)
	const mainAccountName = params.accountName || (mainCategory.type === 'income' ? 'Sales' : 'General Expense')
	const mainAccount = await ensureAccount(db, {
		restaurantId,
		name: mainAccountName,
		type: mainAccountType,
		categoryId: mainCategory.id,
	})

	const explicitCounterAccountName = params.counterAccountName?.trim()
	const mainPaymentMethod = explicitCounterAccountName
		? params.paymentMethod?.trim() || 'Internal'
		: params.paymentMethod || 'Cash'

	const settlement = explicitCounterAccountName
		? null
		: await resolveSettlementAccount(db, mainPaymentMethod, direction, categories, restaurantId)

	const counterCategoryType = params.counterCategoryType
		|| (settlement?.account.categoryId ? settlement.account.type : 'asset')
	const counterCategory = explicitCounterAccountName
		? (categories[counterCategoryType] || categories.asset)
		: null
	const counterAccount = explicitCounterAccountName
		? await ensureAccount(db, {
			restaurantId,
			name: explicitCounterAccountName,
			type: params.counterAccountType || resolveAccountType(counterCategory?.type || 'asset'),
			categoryId: (counterCategory || categories.asset).id,
		})
		: settlement!.account
	const counterPaymentMethod = explicitCounterAccountName
		? mainPaymentMethod
		: settlement!.paymentMethod

	const pairId = `pair-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
	const sourceKind = params.sourceKind || (params.isManual === false ? 'system' : 'manual')
	const authoritativeForRevenue = params.authoritativeForRevenue ?? true

	if (sourceKind === 'inventory_waste') {
		if (!explicitCounterAccountName) {
			throw new Error('Inventory waste journal entries must use an internal counter account')
		}

		if (isCashEquivalentAccountName(counterAccount.name)) {
			throw new Error('Inventory waste journal entries cannot credit a cash-equivalent account')
		}
	}

	if (direction === 'out') {
		const mainEntry = await db.transaction.create({
			data: {
				userId: params.userId,
				restaurantId,
				branchId: params.branchId ?? null,
				accountId: mainAccount.id,
				categoryId: mainAccount.categoryId,
				date: params.date,
				description: params.description,
				amount: params.amount,
				type: 'debit',
				isManual: params.isManual ?? true,
				paymentMethod: mainPaymentMethod,
				pairId,
				accountName: mainAccount.name,
				sourceKind,
				authoritativeForRevenue,
			},
		})

		const settlementEntry = await db.transaction.create({
			data: {
				userId: params.userId,
				restaurantId,
				branchId: params.branchId ?? null,
				accountId: counterAccount.id,
				categoryId: counterAccount.categoryId,
				date: params.date,
				description: params.description,
				amount: params.amount,
				type: 'credit',
				isManual: params.isManual ?? true,
				paymentMethod: counterPaymentMethod,
				pairId,
				accountName: counterAccount.name,
				sourceKind,
				authoritativeForRevenue,
			},
		})

		return { pairId, entries: [mainEntry, settlementEntry] }
	} else {
		const settlementEntry = await db.transaction.create({
			data: {
				userId: params.userId,
				restaurantId,
				branchId: params.branchId ?? null,
				accountId: counterAccount.id,
				categoryId: counterAccount.categoryId,
				date: params.date,
				description: params.description,
				amount: params.amount,
				type: 'debit',
				isManual: params.isManual ?? true,
				paymentMethod: counterPaymentMethod,
				pairId,
				accountName: counterAccount.name,
				sourceKind,
				authoritativeForRevenue,
			},
		})

		const mainEntry = await db.transaction.create({
			data: {
				userId: params.userId,
				restaurantId,
				branchId: params.branchId ?? null,
				accountId: mainAccount.id,
				categoryId: mainAccount.categoryId,
				date: params.date,
				description: params.description,
				amount: params.amount,
				type: 'credit',
				isManual: params.isManual ?? true,
				paymentMethod: mainPaymentMethod,
				pairId,
				accountName: mainAccount.name,
				sourceKind,
				authoritativeForRevenue,
			},
		})

		return { pairId, entries: [settlementEntry, mainEntry] }
	}

	return { pairId }
}