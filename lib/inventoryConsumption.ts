import type { Prisma, PrismaClient } from '@prisma/client'

import { getActiveFifoUnitCost } from '@/lib/fifoCosting'
import { FIFO_FEATURE_AVAILABLE } from '@/lib/fifoFeature'
import { enqueueSyncChange } from '@/lib/syncOutbox'

type PrismaDb = PrismaClient | Prisma.TransactionClient

type IngredientSnapshot = {
  id: string
  name: string
  unit: string
  unitCost: number | null
  quantity: number
}

type ConsumptionSourceType = 'dishSale' | 'waste' | 'adjustment' | 'prepProduction'

type ConsumeIngredientStockParams = {
  restaurantId: string
  branchId: string
  ingredientId: string
  quantity: number
  fifoEnabled: boolean
  sourceType: ConsumptionSourceType
  sourceId: string
  consumedAt: Date
  reason?: string | null
  ingredientSnapshot?: IngredientSnapshot
  updateIngredientQuantity?: boolean
  // Consume min(quantity, available) instead of throwing Insufficient*Error.
  // Callers read `shortfall` from the result to handle the uncovered remainder.
  allowPartial?: boolean
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

// FIFO is enabled globally — per-restaurant toggle was removed from the schema.
export function getRestaurantFifoEnabled(): boolean {
  return FIFO_FEATURE_AVAILABLE
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
          restaurantId: params.restaurantId,
          branchId: params.branchId,
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
      ingredientId: params.ingredientId,
      remainingQuantity: { gt: 0 },
      restaurantId: params.restaurantId,
      branchId: params.branchId,
    },
    orderBy: [{ purchasedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  })
  const layerSnapshots = layers.map((layer) => ({
    ...layer,
    remainingQuantity: Number(layer.remainingQuantity || 0),
    unitCost: Number(layer.unitCost || 0),
  }))

  const consumesFromBatches = params.fifoEnabled
  const availableBatchQuantity = roundQuantity(
    layerSnapshots.reduce((sum, layer) => sum + Number(layer.remainingQuantity || 0), 0),
  )

  const availableQuantityForMode = consumesFromBatches
    ? availableBatchQuantity
    : roundQuantity(Number(ingredient.quantity || 0))
  const quantityToConsume = params.allowPartial
    ? roundQuantity(Math.min(quantityRequested, Math.max(0, availableQuantityForMode)))
    : quantityRequested

  if (params.allowPartial && quantityToConsume <= 0) {
    return {
      ingredient,
      updatedIngredient: null,
      fifoEnabled: consumesFromBatches,
      quantityRequested,
      quantityConsumed: 0,
      shortfall: quantityRequested,
      totalCost: 0,
      allocations,
    }
  }

  if (consumesFromBatches) {
    if (!params.allowPartial && availableBatchQuantity + Number.EPSILON < quantityRequested) {
      throw new InsufficientFifoStockError(
        params.ingredientId,
        ingredient.name,
        quantityRequested,
        availableBatchQuantity,
        ingredient.unit,
      )
    }

    let remaining = quantityToConsume
    for (const layer of layerSnapshots) {
      if (remaining <= Number.EPSILON) break

      const availableFromLayer = Number(layer.remainingQuantity || 0)
      if (availableFromLayer <= Number.EPSILON) continue

      const quantityConsumed = roundQuantity(Math.min(availableFromLayer, remaining))
      if (quantityConsumed <= Number.EPSILON) continue

      remaining = roundQuantity(remaining - quantityConsumed)
      const unitCost = Number(layer.unitCost || 0)
      const allocationCost = roundQuantity(quantityConsumed * unitCost)
      const effectiveBatchId = String(layer.batchId || layer.id)
      totalCost = roundQuantity(totalCost + allocationCost)

      const updatedPurchase = await db.inventoryPurchase.update({
        where: { id: layer.id },
        data: { remainingQuantity: { decrement: quantityConsumed } },
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
          restaurantId: params.restaurantId,
          branchId: params.branchId,
          purchaseId: layer.id,
          ingredientId: params.ingredientId,
          sourceType: params.sourceType,
          sourceId: params.sourceId,
          batchId: effectiveBatchId,
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
        batchId: effectiveBatchId,
        quantityConsumed,
        unitCost,
        totalCost: allocationCost,
        ledgerId: usage.id,
      })
    }
  } else {
    const availableQuantity = roundQuantity(Number(ingredient.quantity || 0))
    if (!params.allowPartial && availableQuantity + Number.EPSILON < quantityRequested) {
      throw new InsufficientInventoryStockError(
        params.ingredientId,
        ingredient.name,
        quantityRequested,
        availableQuantity,
        ingredient.unit,
      )
    }

    totalCost = roundQuantity(quantityToConsume * Number(ingredient.unitCost ?? 0))
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
            // Relative decrement, not an absolute set from a stale snapshot —
            // avoids a lost-update race when concurrent consumptions hit the
            // same ingredient (each write only applies its own delta).
            quantity: { decrement: quantityToConsume },
            unitCost: nextActiveUnitCost ?? 0,
          }
        : { quantity: { decrement: quantityToConsume } },
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
    quantityRequested,
    quantityConsumed: quantityToConsume,
    shortfall: roundQuantity(Math.max(0, quantityRequested - quantityToConsume)),
    totalCost,
    allocations,
  }
}
