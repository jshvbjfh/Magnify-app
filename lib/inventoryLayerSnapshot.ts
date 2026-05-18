import type { Prisma, PrismaClient } from '@prisma/client'

type PrismaDb = PrismaClient | Prisma.TransactionClient

const LAYER_EPSILON = 0.000001

function roundQty(value: number) {
	return Math.round((value + Number.EPSILON) * 1000) / 1000
}

export type IngredientLayerTotal = {
	quantity: number
	value: number
	purchaseCount: number
	openPurchaseCount: number
}

export async function getIngredientLayerSnapshotAsOf(
	db: PrismaDb,
	params: {
		restaurantId?: string | null
		branchId?: string | null
		endDate?: Date | null
	},
) {
	const purchases = await db.inventoryPurchase.findMany({
		where: {
			...(params.restaurantId ? { restaurantId: params.restaurantId } : {}),
			...(params.branchId ? { branchId: params.branchId } : {}),
			...(params.endDate ? { purchasedAt: { lte: params.endDate } } : {}),
		},
		select: {
			id: true,
			ingredientId: true,
			quantityPurchased: true,
			unitCost: true,
		},
	})

	const ingredientTotals = new Map<string, IngredientLayerTotal>()
	const hasPurchaseHistory = new Set<string>()

	if (purchases.length === 0) {
		return {
			ingredientTotals,
			hasPurchaseHistory,
		}
	}

	const purchaseIds = purchases.map((purchase) => purchase.id)
	const usageRows = await db.inventoryBatchUsageLedger.findMany({
		where: {
			...(params.restaurantId ? { restaurantId: params.restaurantId } : {}),
			...(params.branchId ? { branchId: params.branchId } : {}),
			purchaseId: { in: purchaseIds },
			...(params.endDate ? { consumedAt: { lte: params.endDate } } : {}),
		},
		select: {
			purchaseId: true,
			quantityConsumed: true,
		},
	})

	const consumedByPurchaseId = new Map<string, number>()
	for (const usage of usageRows) {
		consumedByPurchaseId.set(
			usage.purchaseId,
			roundQty((consumedByPurchaseId.get(usage.purchaseId) ?? 0) + Number(usage.quantityConsumed ?? 0)),
		)
	}

	for (const purchase of purchases) {
		hasPurchaseHistory.add(purchase.ingredientId)

		const purchasedQuantity = roundQty(Number(purchase.quantityPurchased ?? 0))
		const consumedQuantity = roundQty(consumedByPurchaseId.get(purchase.id) ?? 0)
		const remainingQuantity = roundQty(Math.max(0, purchasedQuantity - consumedQuantity))
		const stockValue = roundQty(remainingQuantity * Number(purchase.unitCost ?? 0))

		const totals = ingredientTotals.get(purchase.ingredientId) ?? {
			quantity: 0,
			value: 0,
			purchaseCount: 0,
			openPurchaseCount: 0,
		}

		totals.purchaseCount += 1
		if (remainingQuantity > LAYER_EPSILON) {
			totals.quantity = roundQty(totals.quantity + remainingQuantity)
			totals.value = roundQty(totals.value + stockValue)
			totals.openPurchaseCount += 1
		}

		ingredientTotals.set(purchase.ingredientId, totals)
	}

	return {
		ingredientTotals,
		hasPurchaseHistory,
	}
}
