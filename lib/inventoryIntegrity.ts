import type { Prisma, PrismaClient } from '@prisma/client'

type PrismaDb = PrismaClient | Prisma.TransactionClient

type InventoryIntegrityInput = {
	restaurantId: string
	branchId?: string | null
}

export type InventoryIntegrityRow = {
	ingredientId: string
	ingredientName: string
	unit: string
	unitCost: number | null
	itemQuantity: number
	layerQuantity: number
	driftQuantity: number
	openLayerCount: number
	hasDrift: boolean
}

function roundQuantity(value: number) {
	return Math.round(value * 1000) / 1000
}

export async function getRestaurantInventoryIntegrity(
	db: PrismaDb,
	params: InventoryIntegrityInput
) {
	const [items, layerGroups] = await Promise.all([
		db.inventoryItem.findMany({
			where: {
				restaurantId: params.restaurantId,
				...(params.branchId ? { branchId: params.branchId } : {}),
			},
			select: {
				id: true,
				name: true,
				unit: true,
				unitCost: true,
				quantity: true,
			},
			orderBy: { name: 'asc' },
		}),
		db.inventoryPurchase.groupBy({
			by: ['ingredientId'],
			where: {
				restaurantId: params.restaurantId,
				...(params.branchId ? { branchId: params.branchId } : {}),
			},
			_sum: { remainingQuantity: true },
			_count: { ingredientId: true },
		}),
	])

	const layerMap = new Map(
		layerGroups.map((group) => [
			group.ingredientId,
			{
				layerQuantity: Number(group._sum?.remainingQuantity ?? 0),
				openLayerCount: group._count?.ingredientId ?? 0,
			},
		])
	)

	const rows = items.map<InventoryIntegrityRow>((item) => {
		const layerData = layerMap.get(item.id)
		const itemQuantity = Number(item.quantity ?? 0)
		const layerQuantity = Number(layerData?.layerQuantity ?? 0)
		const driftQuantity = roundQuantity(itemQuantity - layerQuantity)

		return {
			ingredientId: item.id,
			ingredientName: item.name,
			unit: item.unit,
			unitCost: item.unitCost == null ? null : Number(item.unitCost),
			itemQuantity: roundQuantity(itemQuantity),
			layerQuantity: roundQuantity(layerQuantity),
			driftQuantity,
			openLayerCount: Number(layerData?.openLayerCount ?? 0),
			hasDrift: Math.abs(driftQuantity) > 0.0001,
		}
	})

	const mismatches = rows.filter((row) => row.hasDrift)

	return {
		rows,
		mismatches,
		summary: {
			totalIngredients: rows.length,
			mismatchCount: mismatches.length,
			totalAbsoluteDrift: roundQuantity(mismatches.reduce((sum, row) => sum + Math.abs(row.driftQuantity), 0)),
		},
	}
}