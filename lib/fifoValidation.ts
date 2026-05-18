import type { Prisma, PrismaClient } from '@prisma/client'

import { getRestaurantInventoryIntegrity } from '@/lib/inventoryIntegrity'

type PrismaDb = PrismaClient | Prisma.TransactionClient

function roundQty(value: number) {
	return Math.round((value + Number.EPSILON) * 1000) / 1000
}

function summarizeMismatch(expected: number, actual: number) {
	return Math.abs(roundQty(expected - actual)) > 0.001
}

export async function getRestaurantFifoValidation(
	db: PrismaDb,
	params: {
		billingUserId: string
		restaurantId: string
		branchId?: string | null
	},
) {
	const restaurant = await db.restaurant.findFirst({
		where: {
			id: params.restaurantId,
			ownerId: params.billingUserId,
		},
		select: {
			id: true,
			name: true,
		},
	})

	if (!restaurant) {
		throw new Error('Restaurant not found for FIFO validation.')
	}

	const integrity = await getRestaurantInventoryIntegrity(db, {
		restaurantId: params.restaurantId,
		branchId: params.branchId ?? null,
	})

	let salesChecked = 0
	let saleIngredientChecks = 0
	let salesMissingUsageCount = 0
	let salesQuantityMismatchCount = 0
	let wasteLogsChecked = 0
	let wasteMissingUsageCount = 0
	let wasteQuantityMismatchCount = 0

	const [sales, wasteLogs, usageLedger] = await Promise.all([
		db.dishSale.findMany({
			where: {
				restaurantId: params.restaurantId,
				...(params.branchId ? { branchId: params.branchId } : {}),
			},
			include: {
				dish: {
					include: {
						ingredients: true,
					},
				},
			},
		}),
		db.wasteLog.findMany({
			where: {
				restaurantId: params.restaurantId,
				...(params.branchId ? { branchId: params.branchId } : {}),
			},
			select: {
				id: true,
				ingredientId: true,
				quantityWasted: true,
			},
		}),
		db.inventoryBatchUsageLedger.findMany({
			where: {
				restaurantId: params.restaurantId,
				...(params.branchId ? { branchId: params.branchId } : {}),
				sourceType: { in: ['dishSale', 'waste'] },
			},
			select: {
				sourceId: true,
				sourceType: true,
				ingredientId: true,
				quantityConsumed: true,
			},
		}),
	])

	const dishUsageMap = new Map<string, number>()
	const wasteUsageMap = new Map<string, number>()

	for (const row of usageLedger) {
		const key = `${row.sourceId}:${row.ingredientId}`
		const targetMap = row.sourceType === 'dishSale' ? dishUsageMap : wasteUsageMap
		targetMap.set(key, roundQty((targetMap.get(key) ?? 0) + Number(row.quantityConsumed ?? 0)))
	}

	salesChecked = sales.length
	for (const sale of sales) {
		for (const ingredient of sale.dish.ingredients) {
			saleIngredientChecks += 1
			const expectedQty = roundQty(Number(ingredient.quantityRequired ?? 0) * Number(sale.quantitySold ?? 0))
			const actualQty = dishUsageMap.get(`${sale.id}:${ingredient.inventoryItemId}`) ?? 0

			if (actualQty <= 0) {
				salesMissingUsageCount += 1
				continue
			}

			if (summarizeMismatch(expectedQty, actualQty)) {
				salesQuantityMismatchCount += 1
			}
		}
	}

	wasteLogsChecked = wasteLogs.length
	for (const waste of wasteLogs) {
		const actualQty = wasteUsageMap.get(`${waste.id}:${waste.ingredientId}`) ?? 0
		if (actualQty <= 0) {
			wasteMissingUsageCount += 1
			continue
		}

		if (summarizeMismatch(Number(waste.quantityWasted ?? 0), actualQty)) {
			wasteQuantityMismatchCount += 1
		}
	}

	const hasValidationProblems =
		integrity.summary.mismatchCount > 0 ||
		salesMissingUsageCount > 0 ||
		salesQuantityMismatchCount > 0 ||
		wasteMissingUsageCount > 0 ||
		wasteQuantityMismatchCount > 0

	const status = hasValidationProblems ? 'attention' : 'live'

	return {
		status,
		restaurant: {
			id: restaurant.id,
			name: restaurant.name,
			rolloutAvailable: true,
			runtimeActive: true,
		},
		summary: {
			integrityMismatchCount: integrity.summary.mismatchCount,
			integrityTotalAbsoluteDrift: integrity.summary.totalAbsoluteDrift,
			salesChecked,
			saleIngredientChecks,
			salesMissingUsageCount,
			salesQuantityMismatchCount,
			wasteLogsChecked,
			wasteMissingUsageCount,
			wasteQuantityMismatchCount,
		},
	}
}
