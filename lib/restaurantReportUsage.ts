import type { Prisma, PrismaClient } from '@prisma/client'

type PrismaDb = PrismaClient | Prisma.TransactionClient

type QtyCost = {
	qty: number
	cost: number
}

function roundQty(value: number) {
	return Math.round((value + Number.EPSILON) * 1000) / 1000
}

function addQtyCost(map: Map<string, QtyCost>, ingredientId: string, qty: number, cost: number) {
	const current = map.get(ingredientId) ?? { qty: 0, cost: 0 }
	current.qty = roundQty(current.qty + qty)
	current.cost = roundQty(current.cost + cost)
	map.set(ingredientId, current)
}

function isBeforeRange(date: Date, startDate: Date | null) {
	return startDate ? date < startDate : false
}

function isInRange(date: Date, startDate: Date | null, endDate: Date | null) {
	if (startDate && date < startDate) return false
	if (endDate && date > endDate) return false
	return true
}

export async function getDishSaleUsageBreakdown(
	db: PrismaDb,
	params: {
		billingUserId: string
		restaurantId?: string | null
		branchId?: string | null
		includeBranchlessRows?: boolean
		startDate?: Date | null
		endDate?: Date | null
	},
) {
	const branchScopeWhere = params.branchId
		? params.includeBranchlessRows
			? { OR: [{ branchId: params.branchId }, { branchId: null }] }
			: { branchId: params.branchId }
		: {}

	const whereBase = {
		userId: params.billingUserId,
		...(params.restaurantId ? { restaurantId: params.restaurantId } : {}),
		...branchScopeWhere,
	}

	const [ledgerRows, dishSales] = await Promise.all([
		db.inventoryBatchUsageLedger.findMany({
			where: {
				...whereBase,
				sourceType: 'dishSale',
				...(params.endDate ? { consumedAt: { lte: params.endDate } } : {}),
			},
			select: {
				sourceId: true,
				ingredientId: true,
				quantityConsumed: true,
				totalCost: true,
				consumedAt: true,
			},
		}),
		db.dishSale.findMany({
			where: {
				...whereBase,
				...(params.endDate ? { saleDate: { lte: params.endDate } } : {}),
			},
			include: {
				dish: {
					include: {
						ingredients: {
							include: {
								ingredient: {
									select: { unitCost: true },
								},
							},
						},
					},
				},
			},
		}),
	])

	const beforeUsageMap = new Map<string, QtyCost>()
	const periodUsageMap = new Map<string, QtyCost>()
	const totalUsageToEndMap = new Map<string, QtyCost>()
	const ledgerUsageBySourceIngredient = new Set<string>()
	const hasLedgerUsage = new Set<string>()
	const hasFallbackUsage = new Set<string>()

	for (const ledgerRow of ledgerRows) {
		const key = `${ledgerRow.sourceId}:${ledgerRow.ingredientId}`
		ledgerUsageBySourceIngredient.add(key)
		hasLedgerUsage.add(ledgerRow.ingredientId)

		const qty = roundQty(Number(ledgerRow.quantityConsumed ?? 0))
		const cost = roundQty(Number(ledgerRow.totalCost ?? 0))
		addQtyCost(totalUsageToEndMap, ledgerRow.ingredientId, qty, cost)

		if (isBeforeRange(ledgerRow.consumedAt, params.startDate ?? null)) {
			addQtyCost(beforeUsageMap, ledgerRow.ingredientId, qty, cost)
			continue
		}

		if (isInRange(ledgerRow.consumedAt, params.startDate ?? null, params.endDate ?? null)) {
			addQtyCost(periodUsageMap, ledgerRow.ingredientId, qty, cost)
		}
	}

	for (const sale of dishSales) {
		const saleDate = sale.saleDate
		const bucket = isBeforeRange(saleDate, params.startDate ?? null)
			? 'before'
			: isInRange(saleDate, params.startDate ?? null, params.endDate ?? null)
				? 'period'
				: null

		for (const ingredientRow of sale.dish.ingredients) {
			const key = `${sale.id}:${ingredientRow.ingredientId}`
			if (ledgerUsageBySourceIngredient.has(key)) continue

			const qty = roundQty(Number(ingredientRow.quantityRequired ?? 0) * Number(sale.quantitySold ?? 0))
			const cost = roundQty(qty * Number(ingredientRow.ingredient.unitCost ?? 0))
			hasFallbackUsage.add(ingredientRow.ingredientId)
			addQtyCost(totalUsageToEndMap, ingredientRow.ingredientId, qty, cost)

			if (bucket === 'before') {
				addQtyCost(beforeUsageMap, ingredientRow.ingredientId, qty, cost)
			}

			if (bucket === 'period') {
				addQtyCost(periodUsageMap, ingredientRow.ingredientId, qty, cost)
			}
		}
	}

	const usageModeByIngredient = new Map<string, 'fifo' | 'recipe' | 'mixed' | 'none'>()
	const ingredientIds = new Set<string>([
		...Array.from(hasLedgerUsage),
		...Array.from(hasFallbackUsage),
	])

	for (const ingredientId of ingredientIds) {
		const usedLedger = hasLedgerUsage.has(ingredientId)
		const usedFallback = hasFallbackUsage.has(ingredientId)
		usageModeByIngredient.set(
			ingredientId,
			usedLedger && usedFallback ? 'mixed' : usedLedger ? 'fifo' : usedFallback ? 'recipe' : 'none',
		)
	}

	return {
		beforeUsageMap,
		periodUsageMap,
		totalUsageToEndMap,
		hasLedgerUsage,
		hasFallbackUsage,
		usageModeByIngredient,
	}
}