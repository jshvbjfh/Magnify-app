import type { Prisma, PrismaClient } from '@prisma/client'

import { generateInventoryBatchId } from '@/lib/inventoryBatch'
import { getRestaurantInventoryIntegrity } from '@/lib/inventoryIntegrity'
import { enqueueSyncChange } from '@/lib/syncOutbox'

type PrismaDb = PrismaClient | Prisma.TransactionClient

type ReconciliationParams = {
	billingUserId: string
	restaurantId: string
	branchId?: string | null
	effectiveAt?: Date
	ingredientIds?: string[]
}

type ReconciliationAction = {
	ingredientId: string
	ingredientName: string
	unit: string
	unitCost: number | null
	itemQuantity: number
	layerQuantity: number
	driftQuantity: number
	direction: 'create-opening-layer' | 'reduce-open-layers'
	batchId: string | null
	reason: string
}

function roundQuantity(value: number) {
	return Math.round(value * 1000) / 1000
}

function normalizeIngredientIds(values?: string[]) {
	if (!Array.isArray(values) || values.length === 0) return null
	const normalized = values
		.map((value) => String(value || '').trim())
		.filter(Boolean)

	return normalized.length > 0 ? normalized : null
}

function resolveEffectiveAt(value?: Date) {
	if (value && !Number.isNaN(value.getTime())) return value
	return new Date()
}

export async function previewRestaurantInventoryReconciliation(
	db: PrismaDb,
	params: ReconciliationParams,
) {
	const effectiveAt = resolveEffectiveAt(params.effectiveAt)
	const ingredientIds = normalizeIngredientIds(params.ingredientIds)
	const integrity = await getRestaurantInventoryIntegrity(db, {
		billingUserId: params.billingUserId,
		restaurantId: params.restaurantId,
		branchId: params.branchId ?? null,
	})

	const rows = ingredientIds
		? integrity.rows.filter((row) => ingredientIds.includes(row.ingredientId))
		: integrity.rows

	const actions: ReconciliationAction[] = rows
		.filter((row) => row.hasDrift)
		.map((row) => ({
			ingredientId: row.ingredientId,
			ingredientName: row.ingredientName,
			unit: row.unit,
			unitCost: row.unitCost,
			itemQuantity: row.itemQuantity,
			layerQuantity: row.layerQuantity,
			driftQuantity: row.driftQuantity,
			direction: row.driftQuantity > 0 ? 'create-opening-layer' : 'reduce-open-layers',
			batchId: row.driftQuantity > 0 ? generateInventoryBatchId(effectiveAt) : null,
			reason: row.driftQuantity > 0
				? 'Create a synthetic opening layer so purchase layers match the current ingredient quantity.'
				: 'Reduce open purchase layers oldest-first so purchase layers match the current ingredient quantity.',
		}))

	return {
		effectiveAt: effectiveAt.toISOString(),
		actions,
		summary: {
			totalActions: actions.length,
			positiveAdjustments: actions.filter((action) => action.driftQuantity > 0).length,
			negativeAdjustments: actions.filter((action) => action.driftQuantity < 0).length,
			totalPositiveDrift: roundQuantity(actions.filter((action) => action.driftQuantity > 0).reduce((sum, action) => sum + action.driftQuantity, 0)),
			totalNegativeDrift: roundQuantity(actions.filter((action) => action.driftQuantity < 0).reduce((sum, action) => sum + Math.abs(action.driftQuantity), 0)),
		},
	}
}

export async function applyRestaurantInventoryReconciliation(
	db: PrismaDb,
	params: ReconciliationParams,
) {
	const preview = await previewRestaurantInventoryReconciliation(db, params)
	const effectiveAt = new Date(preview.effectiveAt)
	const restaurant = await db.restaurant.findFirst({
		where: {
			id: params.restaurantId,
			ownerId: params.billingUserId,
		},
	})

	if (!restaurant) {
		throw new Error('Restaurant not found for reconciliation.')
	}

	if (
		restaurant.fifoCutoverAt &&
		restaurant.fifoCutoverAt.toISOString() !== effectiveAt.toISOString()
	) {
		throw new Error(
			`FIFO cutover is already recorded for ${restaurant.fifoCutoverAt.toISOString()}. Reconciliation apply expects the same effectiveAt once a branch has been cut over.`,
		)
	}

	const updatedRestaurant = await db.restaurant.update({
		where: { id: restaurant.id },
		data: {
			fifoEnabled: true,
			fifoConfiguredAt: restaurant.fifoConfiguredAt ?? new Date(),
			fifoCutoverAt: restaurant.fifoCutoverAt ?? effectiveAt,
		},
	})

	await enqueueSyncChange(db, {
		restaurantId: params.restaurantId,
		branchId: params.branchId ?? null,
		entityType: 'restaurant',
		entityId: updatedRestaurant.id,
		operation: 'upsert',
		payload: updatedRestaurant,
	})

	const appliedActions: Array<ReconciliationAction & { adjustmentLogId: string; usageLedgerIds: string[] }> = []

	for (const action of preview.actions) {
		if (action.direction === 'create-opening-layer') {
			const quantityDelta = roundQuantity(action.driftQuantity)
			const unitCost = Number(action.unitCost ?? 0)
			const purchase = await db.inventoryPurchase.create({
				data: {
					userId: params.billingUserId,
					restaurantId: params.restaurantId,
					branchId: params.branchId ?? null,
					batchId: action.batchId,
					ingredientId: action.ingredientId,
					supplier: 'FIFO Opening Balance Reconciliation',
					quantityPurchased: quantityDelta,
					remainingQuantity: quantityDelta,
					unitCost,
					totalCost: roundQuantity(quantityDelta * unitCost),
					purchasedAt: effectiveAt,
				},
			})

			const adjustmentLog = await db.inventoryAdjustmentLog.create({
				data: {
					userId: params.billingUserId,
					restaurantId: params.restaurantId,
					branchId: params.branchId ?? null,
					ingredientId: action.ingredientId,
					adjustmentType: 'opening_balance',
					quantityDelta,
					itemQuantityBefore: action.itemQuantity,
					itemQuantityAfter: action.itemQuantity,
					batchId: action.batchId,
					reason: 'Layer reconciliation created a synthetic opening balance without changing the ingredient master quantity.',
				},
			})

			await enqueueSyncChange(db, {
				restaurantId: params.restaurantId,
				branchId: params.branchId ?? null,
				entityType: 'inventoryPurchase',
				entityId: purchase.id,
				operation: 'upsert',
				payload: purchase,
			})

			await enqueueSyncChange(db, {
				restaurantId: params.restaurantId,
				branchId: params.branchId ?? null,
				entityType: 'inventoryAdjustmentLog',
				entityId: adjustmentLog.id,
				operation: 'upsert',
				payload: adjustmentLog,
			})

			appliedActions.push({
				...action,
				adjustmentLogId: adjustmentLog.id,
				usageLedgerIds: [],
			})
			continue
		}

		let remainingToReduce = Math.abs(action.driftQuantity)
		const adjustmentLog = await db.inventoryAdjustmentLog.create({
			data: {
				userId: params.billingUserId,
				restaurantId: params.restaurantId,
				branchId: params.branchId ?? null,
				ingredientId: action.ingredientId,
				adjustmentType: 'correction',
				quantityDelta: -remainingToReduce,
				itemQuantityBefore: action.itemQuantity,
				itemQuantityAfter: action.itemQuantity,
				batchId: null,
				reason: 'Layer reconciliation reduced open purchase layers oldest-first without changing the ingredient master quantity.',
			},
		})

		await enqueueSyncChange(db, {
			restaurantId: params.restaurantId,
			branchId: params.branchId ?? null,
			entityType: 'inventoryAdjustmentLog',
			entityId: adjustmentLog.id,
			operation: 'upsert',
			payload: adjustmentLog,
		})

		const usageLedgerIds: string[] = []
		const layers = await db.inventoryPurchase.findMany({
			where: {
				userId: params.billingUserId,
				restaurantId: params.restaurantId,
				...(params.branchId ? { branchId: params.branchId } : {}),
				ingredientId: action.ingredientId,
				remainingQuantity: { gt: 0 },
			},
			orderBy: [{ purchasedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
		})

		for (const layer of layers) {
			if (remainingToReduce <= Number.EPSILON) break

			const available = Number(layer.remainingQuantity ?? 0)
			if (available <= Number.EPSILON) continue

			const quantityConsumed = roundQuantity(Math.min(available, remainingToReduce))
			remainingToReduce = roundQuantity(remainingToReduce - quantityConsumed)

			const updatedLayer = await db.inventoryPurchase.update({
				where: { id: layer.id },
				data: {
					remainingQuantity: { decrement: quantityConsumed },
				},
			})

			const usage = await db.inventoryBatchUsageLedger.create({
				data: {
					userId: params.billingUserId,
					restaurantId: params.restaurantId,
					branchId: params.branchId ?? null,
					purchaseId: layer.id,
					ingredientId: action.ingredientId,
					sourceType: 'adjustment',
					sourceId: adjustmentLog.id,
					batchId: layer.batchId ?? layer.id,
					quantityConsumed,
					unitCost: Number(layer.unitCost),
					totalCost: roundQuantity(quantityConsumed * Number(layer.unitCost)),
					reason: 'Layer reconciliation reduced historical open quantity to match the ingredient master quantity.',
					consumedAt: effectiveAt,
				},
			})

			await enqueueSyncChange(db, {
				restaurantId: params.restaurantId,
				branchId: params.branchId ?? null,
				entityType: 'inventoryPurchase',
				entityId: updatedLayer.id,
				operation: 'upsert',
				payload: updatedLayer,
			})

			await enqueueSyncChange(db, {
				restaurantId: params.restaurantId,
				branchId: params.branchId ?? null,
				entityType: 'inventoryBatchUsageLedger',
				entityId: usage.id,
				operation: 'upsert',
				payload: usage,
			})

			usageLedgerIds.push(usage.id)
		}

		if (remainingToReduce > 0.0001) {
			throw new Error(`Could not fully reduce open layers for ${action.ingredientName}. ${remainingToReduce} ${action.unit} still remains after reconciliation.`)
		}

		appliedActions.push({
			...action,
			adjustmentLogId: adjustmentLog.id,
			usageLedgerIds,
		})
	}

	return {
		...preview,
		restaurant: {
			id: updatedRestaurant.id,
			fifoEnabled: updatedRestaurant.fifoEnabled,
			fifoConfiguredAt: updatedRestaurant.fifoConfiguredAt?.toISOString() ?? null,
			fifoCutoverAt: updatedRestaurant.fifoCutoverAt?.toISOString() ?? null,
		},
		appliedAt: new Date().toISOString(),
		appliedActions,
	}
}