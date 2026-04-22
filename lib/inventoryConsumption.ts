import type { Prisma, PrismaClient } from '@prisma/client'

import { getActiveFifoUnitCost } from '@/lib/fifoCosting'
import { getEffectiveFifoEnabled, getStoredFifoEnabled } from '@/lib/fifoFeature'
import { getRestaurantFifoRuntimeAvailability } from '@/lib/fifoRollout'
import { enqueueSyncChange } from '@/lib/syncOutbox'

type PrismaDb = PrismaClient | Prisma.TransactionClient

type IngredientSnapshot = {
	id: string
	name: string
	unit: string
	unitCost: number | null
	quantity: number
}

type ConsumptionSourceType = 'dishSale' | 'waste' | 'adjustment'

type ConsumeIngredientStockParams = {
	billingUserId: string
	restaurantId?: string | null
	branchId?: string | null
	ingredientId: string
	quantity: number
	fifoEnabled: boolean
	sourceType: ConsumptionSourceType
	sourceId: string
	consumedAt: Date
	reason?: string | null
	ingredientSnapshot?: IngredientSnapshot
	updateIngredientQuantity?: boolean
}

function roundQuantity(value: number) {
	return Math.round(value * 1000) / 1000
}

export class InsufficientFifoStockError extends Error {
	constructor(
		public readonly ingredientId: string,
		public readonly ingredientName: string,
		public readonly requiredQuantity: number,
		public readonly availableQuantity: number,
		public readonly unit: string,
	) {
		super(
			`Not enough FIFO stock for ${ingredientName}. Required ${requiredQuantity} ${unit}, but only ${availableQuantity} ${unit} is available.`,
		)
		this.name = 'InsufficientFifoStockError'
	}
}

export class InsufficientInventoryStockError extends Error {
	constructor(
		public readonly ingredientId: string,
		public readonly ingredientName: string,
		public readonly requiredQuantity: number,
		public readonly availableQuantity: number,
		public readonly unit: string,
	) {
		super(
			`Not enough stock for ${ingredientName}. Required ${requiredQuantity} ${unit}, but only ${availableQuantity} ${unit} is available.`,
		)
		this.name = 'InsufficientInventoryStockError'
	}
}

export async function getRestaurantFifoEnabled(
	db: PrismaDb,
	params: {
		billingUserId: string
		restaurantId?: string | null
	},
) {
	const [restaurant, owner] = await Promise.all([
		params.restaurantId
			? db.restaurant.findUnique({
				where: { id: params.restaurantId },
				select: { id: true, syncRestaurantId: true, fifoEnabled: true, fifoCutoverAt: true },
			})
			: Promise.resolve(null),
		db.user.findUnique({
			where: { id: params.billingUserId },
			select: { fifoEnabled: true },
		}),
	])

	return getEffectiveFifoEnabled(
		getStoredFifoEnabled(restaurant?.fifoEnabled, owner?.fifoEnabled),
		getRestaurantFifoRuntimeAvailability(restaurant),
	)
}

export async function consumeIngredientStock(
	db: PrismaDb,
	params: ConsumeIngredientStockParams,
) {
	const quantityRequested = roundQuantity(Number(params.quantity))
	if (!Number.isFinite(quantityRequested) || quantityRequested <= 0) {
		throw new Error('Ingredient consumption quantity must be greater than 0.')
	}

	const ingredient = params.ingredientSnapshot
		? params.ingredientSnapshot
		: await db.inventoryItem.findFirst({
				where: {
					id: params.ingredientId,
					userId: params.billingUserId,
					inventoryType: 'ingredient',
					...(params.restaurantId ? { restaurantId: params.restaurantId } : {}),
					...(params.branchId ? { branchId: params.branchId } : {}),
				},
				select: {
					id: true,
					name: true,
					unit: true,
					unitCost: true,
					quantity: true,
				},
			})

	if (!ingredient) {
		throw new Error(`Ingredient ${params.ingredientId} was not found.`)
	}

	const allocations: Array<{
		purchaseId: string
		batchId: string
		quantityConsumed: number
		unitCost: number
		totalCost: number
		ledgerId: string
	}> = []
	let totalCost = 0
	const layers = await db.inventoryPurchase.findMany({
		where: {
			userId: params.billingUserId,
			ingredientId: params.ingredientId,
			remainingQuantity: { gt: 0 },
			...(params.restaurantId ? { restaurantId: params.restaurantId } : {}),
			...(params.branchId ? { branchId: params.branchId } : {}),
		},
		orderBy: [{ purchasedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
	})
	const layerSnapshots = layers.map((layer) => ({
		...layer,
		remainingQuantity: Number(layer.remainingQuantity || 0),
		unitCost: Number(layer.unitCost || 0),
	}))

	const consumesFromBatches = params.fifoEnabled || layerSnapshots.length > 0
	const availableBatchQuantity = roundQuantity(
		layerSnapshots.reduce((sum, layer) => sum + Number(layer.remainingQuantity || 0), 0),
	)

	if (consumesFromBatches) {
		if (availableBatchQuantity + Number.EPSILON < quantityRequested) {
			throw new InsufficientFifoStockError(
				params.ingredientId,
				ingredient.name,
				quantityRequested,
				availableBatchQuantity,
				ingredient.unit,
			)
		}

		let remaining = quantityRequested
		for (const layer of layerSnapshots) {
			if (remaining <= Number.EPSILON) break

			const availableFromLayer = Number(layer.remainingQuantity || 0)
			if (availableFromLayer <= Number.EPSILON) continue

			const quantityConsumed = roundQuantity(Math.min(availableFromLayer, remaining))
			if (quantityConsumed <= Number.EPSILON) continue

			remaining = roundQuantity(remaining - quantityConsumed)
			const unitCost = Number(layer.unitCost || 0)
			const allocationCost = roundQuantity(quantityConsumed * unitCost)
			totalCost = roundQuantity(totalCost + allocationCost)

			const updatedPurchase = await db.inventoryPurchase.update({
				where: { id: layer.id },
				data: {
					remainingQuantity: { decrement: quantityConsumed },
				},
			})
			layer.remainingQuantity = Number(updatedPurchase.remainingQuantity || 0)

			await enqueueSyncChange(db, {
				restaurantId: params.restaurantId,
				branchId: params.branchId,
				entityType: 'inventoryPurchase',
				entityId: updatedPurchase.id,
				operation: 'upsert',
				payload: updatedPurchase,
			})

			const usage = await db.inventoryBatchUsageLedger.create({
				data: {
					userId: params.billingUserId,
					restaurantId: params.restaurantId ?? null,
					branchId: params.branchId ?? null,
					purchaseId: layer.id,
					ingredientId: params.ingredientId,
					sourceType: params.sourceType,
					sourceId: params.sourceId,
					batchId: layer.batchId ?? layer.id,
					quantityConsumed,
					unitCost,
					totalCost: allocationCost,
					reason: params.reason ?? null,
					consumedAt: params.consumedAt,
				},
			})

			await enqueueSyncChange(db, {
				restaurantId: params.restaurantId,
				branchId: params.branchId,
				entityType: 'inventoryBatchUsageLedger',
				entityId: usage.id,
				operation: 'upsert',
				payload: usage,
			})

			allocations.push({
				purchaseId: layer.id,
				batchId: layer.batchId ?? layer.id,
				quantityConsumed,
				unitCost,
				totalCost: allocationCost,
				ledgerId: usage.id,
			})
		}
	} else {
		const availableQuantity = roundQuantity(Number(ingredient.quantity || 0))
		if (availableQuantity + Number.EPSILON < quantityRequested) {
			throw new InsufficientInventoryStockError(
				params.ingredientId,
				ingredient.name,
				quantityRequested,
				availableQuantity,
				ingredient.unit,
			)
		}

		totalCost = roundQuantity(quantityRequested * Number(ingredient.unitCost ?? 0))
	}

	let updatedIngredient = null
	if (params.updateIngredientQuantity !== false) {
		const nextActiveUnitCost = consumesFromBatches
			? getActiveFifoUnitCost(layerSnapshots, ingredient.unitCost)
			: ingredient.unitCost

		updatedIngredient = await db.inventoryItem.update({
			where: { id: params.ingredientId },
			data: consumesFromBatches
				? {
					quantity: roundQuantity(Math.max(0, availableBatchQuantity - quantityRequested)),
					unitCost: nextActiveUnitCost,
				}
				: { quantity: { decrement: quantityRequested } },
		})

		await enqueueSyncChange(db, {
			restaurantId: params.restaurantId,
			branchId: params.branchId,
			entityType: 'inventoryItem',
			entityId: updatedIngredient.id,
			operation: 'upsert',
			payload: updatedIngredient,
		})
	}

	return {
		ingredient,
		updatedIngredient,
		fifoEnabled: consumesFromBatches,
		quantityConsumed: quantityRequested,
		totalCost,
		allocations,
	}
}