import type { Prisma, PrismaClient, PrepLog } from '@prisma/client'

import { getActiveFifoUnitCost } from '@/lib/fifoCosting'
import { generateInventoryBatchId } from '@/lib/inventoryBatch'
import { consumeIngredientStock, getRestaurantFifoEnabled } from '@/lib/inventoryConsumption'
import { enqueueSyncChange } from '@/lib/syncOutbox'

type PrismaDb = PrismaClient | Prisma.TransactionClient

const LAYER_EPSILON = 0.000001

export const MEP_KITCHEN_SUPPLIER = 'Kitchen (MEP)'

function roundQuantity(value: number) {
  return Math.round(value * 1000) / 1000
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'P2002')
}

export type PrepAwareIngredient = {
  id: string
  name: string
  unit: string
  type: string | null
  prepIngredients: Array<{
    ingredientItemId: string
    quantityRequired: number
    ingredient?: { name: string } | null
  }>
}

export type MepConsumptionLine = { ingredientId: string; quantityUsed: number; actualCost: number }

async function syncItemActiveUnitCostAfterChange(
  db: PrismaDb,
  params: { restaurantId: string; branchId: string; ingredientId: string },
) {
  const item = await db.inventoryItem.findFirst({
    where: { id: params.ingredientId, restaurantId: params.restaurantId, branchId: params.branchId },
  })
  if (!item) return null

  const openLayers = await db.inventoryPurchase.findMany({
    where: {
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      ingredientId: params.ingredientId,
      remainingQuantity: { gt: LAYER_EPSILON },
    },
    select: { id: true, remainingQuantity: true, unitCost: true, purchasedAt: true, createdAt: true },
    orderBy: [{ purchasedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  })
  const activeUnitCost = getActiveFifoUnitCost(openLayers, item.unitCost)
  if (item.unitCost === activeUnitCost) return item

  return db.inventoryItem.update({ where: { id: item.id }, data: { unitCost: activeUnitCost ?? 0 } })
}

// MEP-first consumer for a prep-type ingredient: drain the prep item's own FIFO
// stock up to what is available, then cascade ONLY the uncovered shortfall to its
// raw sub-ingredients. Never throws on stock — sales and prep logs must not block.
export async function consumePrepAwareIngredient(
  db: PrismaDb,
  params: {
    restaurantId: string
    branchId: string
    ingredient: PrepAwareIngredient
    quantityNeeded: number
    fifoEnabled: boolean
    sourceType: 'dishSale' | 'prepProduction'
    sourceId: string
    consumedAt: Date
    reason: string
  },
): Promise<{ totalCost: number; lines: MepConsumptionLine[]; warnings: string[] }> {
  const lines: MepConsumptionLine[] = []
  const warnings: string[] = []
  let totalCost = 0

  const quantityNeeded = roundQuantity(Number(params.quantityNeeded) || 0)
  if (quantityNeeded <= 0) return { totalCost, lines, warnings }

  let shortfall = quantityNeeded
  try {
    const ownConsumption = await consumeIngredientStock(db, {
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      ingredientId: params.ingredient.id,
      quantity: quantityNeeded,
      fifoEnabled: params.fifoEnabled,
      sourceType: params.sourceType,
      sourceId: params.sourceId,
      consumedAt: params.consumedAt,
      reason: params.reason,
      allowPartial: true,
    })
    shortfall = ownConsumption.shortfall
    if (ownConsumption.quantityConsumed > 0) {
      totalCost = roundQuantity(totalCost + ownConsumption.totalCost)
      lines.push({
        ingredientId: params.ingredient.id,
        quantityUsed: ownConsumption.quantityConsumed,
        actualCost: ownConsumption.totalCost,
      })
    }
  } catch {
    // Prep item missing on this database — fall through to the raw cascade.
  }

  if (shortfall <= 0) return { totalCost, lines, warnings }

  if (params.ingredient.prepIngredients.length === 0) {
    warnings.push(`Out of ${params.ingredient.name} — no recipe to fall back on`)
    return { totalCost, lines, warnings }
  }

  for (const prepRow of params.ingredient.prepIngredients) {
    const rawNeeded = roundQuantity(Number(prepRow.quantityRequired || 0) * shortfall)
    if (rawNeeded <= 0) continue
    try {
      const rawConsumption = await consumeIngredientStock(db, {
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        ingredientId: prepRow.ingredientItemId,
        quantity: rawNeeded,
        fifoEnabled: params.fifoEnabled,
        sourceType: params.sourceType,
        sourceId: params.sourceId,
        consumedAt: params.consumedAt,
        reason: `Prep cascade for ${params.ingredient.name} — ${params.reason}`,
        allowPartial: true,
      })
      totalCost = roundQuantity(totalCost + rawConsumption.totalCost)
      if (rawConsumption.quantityConsumed > 0) {
        lines.push({
          ingredientId: prepRow.ingredientItemId,
          quantityUsed: rawConsumption.quantityConsumed,
          actualCost: rawConsumption.totalCost,
        })
      }
      if (rawConsumption.shortfall > 0) {
        warnings.push(`Low stock: ${prepRow.ingredient?.name ?? 'ingredient'} — used ${rawConsumption.quantityConsumed} of ${rawNeeded}`)
      }
    } catch {
      warnings.push(`Missing ingredient for ${params.ingredient.name} — skipped`)
    }
  }

  return { totalCost, lines, warnings }
}

export type ProduceResult = {
  log: PrepLog
  alreadyExisted: boolean
  remaining: number
  warnings: string[]
}

async function findExistingLog(db: PrismaDb, clientLogId: string | null | undefined) {
  if (!clientLogId) return null
  return db.prepLog.findUnique({ where: { clientLogId } })
}

async function getPrepRemaining(db: PrismaDb, params: { restaurantId: string; branchId: string; itemId: string }) {
  const item = await db.inventoryItem.findFirst({
    where: { id: params.itemId, restaurantId: params.restaurantId, branchId: params.branchId },
    select: { quantity: true },
  })
  return roundQuantity(Number(item?.quantity ?? 0))
}

async function getDishRemaining(db: PrismaDb, params: { restaurantId: string; dishId: string }) {
  const dish = await db.dish.findFirst({
    where: { id: params.dishId, restaurantId: params.restaurantId },
    select: { preparedPortions: true },
  })
  return roundQuantity(Number(dish?.preparedPortions ?? 0))
}

// "Qty prepared" for a prep item: FIFO-consume its raw sub-ingredients now, then
// give the prep its own kitchen-made FIFO layer priced from what the raws cost.
// No expense journal entry — the raws were already expensed when purchased.
export async function producePrepStock(
  db: PrismaDb,
  params: {
    restaurantId: string
    branchId: string
    prepItemId: string
    quantity: number
    madeBy?: string | null
    madeAt?: Date
    clientLogId?: string | null
    sourceDeviceId?: string | null
  },
): Promise<ProduceResult> {
  const quantity = roundQuantity(Number(params.quantity))
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('Prep quantity must be greater than 0.')
  }

  const existing = await findExistingLog(db, params.clientLogId)
  if (existing) {
    return {
      log: existing,
      alreadyExisted: true,
      remaining: await getPrepRemaining(db, { restaurantId: params.restaurantId, branchId: params.branchId, itemId: params.prepItemId }),
      warnings: [],
    }
  }

  const item = await db.inventoryItem.findFirst({
    where: { id: params.prepItemId, restaurantId: params.restaurantId, branchId: params.branchId },
    include: { prepIngredients: { include: { ingredient: true } } },
  })
  if (!item) throw new Error('Prep item not found.')
  if (item.type !== 'prep') throw new Error('Item is not a prep.')

  const madeAt = params.madeAt ?? new Date()
  let log: PrepLog
  try {
    log = await db.prepLog.create({
      data: {
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        targetType: 'prep',
        targetId: item.id,
        quantity,
        unit: item.unit,
        madeBy: params.madeBy ?? null,
        madeAt,
        clientLogId: params.clientLogId ?? null,
      },
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const replayed = await findExistingLog(db, params.clientLogId)
      if (replayed) {
        return {
          log: replayed,
          alreadyExisted: true,
          remaining: await getPrepRemaining(db, { restaurantId: params.restaurantId, branchId: params.branchId, itemId: item.id }),
          warnings: [],
        }
      }
    }
    throw error
  }

  const fifoEnabled = getRestaurantFifoEnabled()
  const warnings: string[] = []
  let totalCost = 0

  for (const prepRow of item.prepIngredients) {
    const rawNeeded = roundQuantity(Number(prepRow.quantityRequired || 0) * quantity)
    if (rawNeeded <= 0) continue
    try {
      const consumption = await consumeIngredientStock(db, {
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        ingredientId: prepRow.ingredientItemId,
        quantity: rawNeeded,
        fifoEnabled,
        sourceType: 'prepProduction',
        sourceId: log.id,
        consumedAt: madeAt,
        reason: `MEP prep production: ${item.name}`,
        allowPartial: true,
      })
      totalCost = roundQuantity(totalCost + consumption.totalCost)
      if (consumption.shortfall > 0) {
        warnings.push(`Low stock: ${prepRow.ingredient?.name ?? 'ingredient'} — used ${consumption.quantityConsumed} of ${rawNeeded} ${consumption.ingredient.unit}`)
      }
    } catch {
      warnings.push(`Missing ingredient: ${prepRow.ingredient?.name ?? prepRow.ingredientItemId} — skipped`)
    }
  }

  const unitCost = quantity > 0 ? roundQuantity(totalCost / quantity) : 0
  const purchase = await db.inventoryPurchase.create({
    data: {
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      ingredientId: item.id,
      batchId: generateInventoryBatchId(madeAt),
      supplier: MEP_KITCHEN_SUPPLIER,
      purchaseQuantity: quantity,
      purchaseUnit: item.unit,
      unitsPerPurchaseUnit: 1,
      purchaseUnitCost: unitCost,
      quantityPurchased: quantity,
      remainingQuantity: quantity,
      unitCost,
      totalCost,
      paymentMethod: 'Internal',
      purchasedAt: madeAt,
      journalEntryId: null,
    },
  })

  await enqueueSyncChange(db, {
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    entityType: 'inventoryPurchase',
    entityId: purchase.id,
    operation: 'upsert',
    sourceDeviceId: params.sourceDeviceId ?? null,
    payload: purchase,
  })

  await db.inventoryItem.update({
    where: { id: item.id },
    data: { quantity: { increment: quantity } },
  })
  const updatedItem = await syncItemActiveUnitCostAfterChange(db, {
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    ingredientId: item.id,
  })

  if (updatedItem) {
    await enqueueSyncChange(db, {
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      entityType: 'inventoryItem',
      entityId: updatedItem.id,
      operation: 'upsert',
      sourceDeviceId: params.sourceDeviceId ?? null,
      payload: updatedItem,
    })
  }

  const finalLog = await db.prepLog.update({
    where: { id: log.id },
    data: { totalCost, costPerUnit: unitCost, producedPurchaseId: purchase.id },
  })

  await enqueueSyncChange(db, {
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    entityType: 'prepLog',
    entityId: finalLog.id,
    operation: 'upsert',
    sourceDeviceId: params.sourceDeviceId ?? null,
    payload: finalLog,
  })

  return {
    log: finalLog,
    alreadyExisted: false,
    remaining: roundQuantity(Number(updatedItem?.quantity ?? 0)),
    warnings,
  }
}

// "Qty prepared" for a dish (batch cooking): consume the dish recipe now
// (prep-first for prep ingredients) and bank the portions on the dish.
export async function produceDishPortions(
  db: PrismaDb,
  params: {
    restaurantId: string
    branchId: string
    dishId: string
    quantity: number
    madeBy?: string | null
    madeAt?: Date
    clientLogId?: string | null
    sourceDeviceId?: string | null
  },
): Promise<ProduceResult> {
  const quantity = roundQuantity(Number(params.quantity))
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('Portion quantity must be greater than 0.')
  }

  const existing = await findExistingLog(db, params.clientLogId)
  if (existing) {
    return {
      log: existing,
      alreadyExisted: true,
      remaining: await getDishRemaining(db, { restaurantId: params.restaurantId, dishId: params.dishId }),
      warnings: [],
    }
  }

  const dish = await db.dish.findFirst({
    where: { id: params.dishId, restaurantId: params.restaurantId },
    include: {
      ingredients: {
        include: {
          inventoryItem: {
            include: { prepIngredients: { include: { ingredient: true } } },
          },
        },
      },
    },
  })
  if (!dish) throw new Error('Dish not found.')

  // Consume from the branch that owns the dish's inventory, same as the sale flow.
  const dishBranchId = dish.branchId ?? params.branchId
  const madeAt = params.madeAt ?? new Date()

  let log: PrepLog
  try {
    log = await db.prepLog.create({
      data: {
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        targetType: 'dish',
        targetId: dish.id,
        quantity,
        unit: 'portion',
        madeBy: params.madeBy ?? null,
        madeAt,
        clientLogId: params.clientLogId ?? null,
      },
    })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const replayed = await findExistingLog(db, params.clientLogId)
      if (replayed) {
        return {
          log: replayed,
          alreadyExisted: true,
          remaining: await getDishRemaining(db, { restaurantId: params.restaurantId, dishId: dish.id }),
          warnings: [],
        }
      }
    }
    throw error
  }

  const fifoEnabled = getRestaurantFifoEnabled()
  const warnings: string[] = []
  let totalCost = 0

  for (const row of dish.ingredients) {
    const quantityRequired = Number(row.quantityRequired || 0)
    if (!Number.isFinite(quantityRequired) || quantityRequired <= 0) continue

    const totalNeeded = roundQuantity(quantityRequired * quantity)
    if (row.inventoryItem.type === 'prep' && row.inventoryItem.prepIngredients.length > 0) {
      const prepConsumption = await consumePrepAwareIngredient(db, {
        restaurantId: params.restaurantId,
        branchId: dishBranchId,
        ingredient: row.inventoryItem,
        quantityNeeded: totalNeeded,
        fifoEnabled,
        sourceType: 'prepProduction',
        sourceId: log.id,
        consumedAt: madeAt,
        reason: `MEP batch cooking: ${dish.name}`,
      })
      totalCost = roundQuantity(totalCost + prepConsumption.totalCost)
      warnings.push(...prepConsumption.warnings)
    } else {
      try {
        const consumption = await consumeIngredientStock(db, {
          restaurantId: params.restaurantId,
          branchId: dishBranchId,
          ingredientId: row.inventoryItemId,
          quantity: totalNeeded,
          fifoEnabled,
          sourceType: 'prepProduction',
          sourceId: log.id,
          consumedAt: madeAt,
          reason: `MEP batch cooking: ${dish.name}`,
          allowPartial: true,
        })
        totalCost = roundQuantity(totalCost + consumption.totalCost)
        if (consumption.shortfall > 0) {
          warnings.push(`Low stock: ${consumption.ingredient.name} — used ${consumption.quantityConsumed} of ${totalNeeded} ${consumption.ingredient.unit}`)
        }
      } catch {
        warnings.push(`Missing ingredient for ${dish.name} — skipped`)
      }
    }
  }

  const costPerPortion = quantity > 0 ? roundQuantity(totalCost / quantity) : 0
  const previousPortions = Math.max(0, roundQuantity(Number(dish.preparedPortions ?? 0)))
  const previousCost = Number(dish.preparedPortionCost ?? 0)
  const nextPortions = roundQuantity(previousPortions + quantity)
  const nextCost = nextPortions > 0
    ? roundQuantity((previousPortions * previousCost + quantity * costPerPortion) / nextPortions)
    : 0

  const updatedDish = await db.dish.update({
    where: { id: dish.id },
    data: { preparedPortions: nextPortions, preparedPortionCost: nextCost },
  })

  await enqueueSyncChange(db, {
    restaurantId: params.restaurantId,
    branchId: dishBranchId,
    entityType: 'dish',
    entityId: updatedDish.id,
    operation: 'upsert',
    sourceDeviceId: params.sourceDeviceId ?? null,
    payload: updatedDish,
  })

  const finalLog = await db.prepLog.update({
    where: { id: log.id },
    data: { totalCost, costPerUnit: costPerPortion },
  })

  await enqueueSyncChange(db, {
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    entityType: 'prepLog',
    entityId: finalLog.id,
    operation: 'upsert',
    sourceDeviceId: params.sourceDeviceId ?? null,
    payload: finalLog,
  })

  return { log: finalLog, alreadyExisted: false, remaining: nextPortions, warnings }
}

export type UndoResult = { ok: true; remaining: number } | { ok: false; reason: string }

// Reverse a prep log: only while the produced stock is untouched. Restores every
// raw FIFO allocation recorded against the log and deletes the ledger rows.
export async function undoPrepLog(
  db: PrismaDb,
  params: {
    restaurantId: string
    branchId: string
    logId?: string | null
    clientLogId?: string | null
    sourceDeviceId?: string | null
  },
): Promise<UndoResult> {
  const log = await db.prepLog.findFirst({
    where: {
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      ...(params.logId ? { id: params.logId } : {}),
      ...(!params.logId && params.clientLogId ? { clientLogId: params.clientLogId } : {}),
    },
  })
  if (!log) return { ok: false, reason: 'Log not found' }

  const currentRemaining = async () =>
    log.targetType === 'prep'
      ? getPrepRemaining(db, { restaurantId: params.restaurantId, branchId: log.branchId, itemId: log.targetId })
      : getDishRemaining(db, { restaurantId: params.restaurantId, dishId: log.targetId })

  if (log.reversedAt) {
    return { ok: true, remaining: await currentRemaining() }
  }

  if (log.targetType === 'prep') {
    const purchase = log.producedPurchaseId
      ? await db.inventoryPurchase.findFirst({ where: { id: log.producedPurchaseId, restaurantId: params.restaurantId } })
      : null
    if (!purchase) return { ok: false, reason: 'Nothing to undo' }
    if (purchase.quantityPurchased - purchase.remainingQuantity > LAYER_EPSILON) {
      return { ok: false, reason: "Already used — can't undo" }
    }

    await db.inventoryPurchase.delete({ where: { id: purchase.id } })
    await enqueueSyncChange(db, {
      restaurantId: params.restaurantId,
      branchId: log.branchId,
      entityType: 'inventoryPurchase',
      entityId: purchase.id,
      operation: 'delete',
      sourceDeviceId: params.sourceDeviceId ?? null,
      payload: { id: purchase.id },
    })

    const prepItem = await db.inventoryItem.findFirst({
      where: { id: log.targetId, restaurantId: params.restaurantId, branchId: log.branchId },
    })
    if (prepItem) {
      await db.inventoryItem.update({
        where: { id: prepItem.id },
        data: { quantity: roundQuantity(Math.max(0, Number(prepItem.quantity || 0) - log.quantity)) },
      })
      const resynced = await syncItemActiveUnitCostAfterChange(db, {
        restaurantId: params.restaurantId,
        branchId: log.branchId,
        ingredientId: prepItem.id,
      })
      if (resynced) {
        await enqueueSyncChange(db, {
          restaurantId: params.restaurantId,
          branchId: log.branchId,
          entityType: 'inventoryItem',
          entityId: resynced.id,
          operation: 'upsert',
          sourceDeviceId: params.sourceDeviceId ?? null,
          payload: resynced,
        })
      }
    }
  } else {
    const dish = await db.dish.findFirst({ where: { id: log.targetId, restaurantId: params.restaurantId } })
    if (!dish) return { ok: false, reason: 'Dish not found' }
    if (Number(dish.preparedPortions ?? 0) + LAYER_EPSILON < log.quantity) {
      return { ok: false, reason: "Already used — can't undo" }
    }

    // preparedPortionCost is intentionally not rewound: reversing a weighted
    // average is lossy, and the next production log re-anchors it anyway.
    const updatedDish = await db.dish.update({
      where: { id: dish.id },
      data: { preparedPortions: roundQuantity(Math.max(0, Number(dish.preparedPortions ?? 0) - log.quantity)) },
    })
    await enqueueSyncChange(db, {
      restaurantId: params.restaurantId,
      branchId: dish.branchId ?? log.branchId,
      entityType: 'dish',
      entityId: updatedDish.id,
      operation: 'upsert',
      sourceDeviceId: params.sourceDeviceId ?? null,
      payload: updatedDish,
    })
  }

  // Restore the raw-material FIFO allocations this log consumed.
  const ledgers = await db.inventoryBatchUsageLedger.findMany({
    where: { restaurantId: params.restaurantId, sourceType: 'prepProduction', sourceId: log.id },
  })
  const restoredByIngredient = new Map<string, number>()
  for (const ledger of ledgers) {
    const restoredPurchase = await db.inventoryPurchase.update({
      where: { id: ledger.purchaseId },
      data: { remainingQuantity: { increment: ledger.quantityConsumed } },
    })
    await enqueueSyncChange(db, {
      restaurantId: params.restaurantId,
      branchId: ledger.branchId,
      entityType: 'inventoryPurchase',
      entityId: restoredPurchase.id,
      operation: 'upsert',
      sourceDeviceId: params.sourceDeviceId ?? null,
      payload: restoredPurchase,
    })

    await db.inventoryBatchUsageLedger.delete({ where: { id: ledger.id } })
    await enqueueSyncChange(db, {
      restaurantId: params.restaurantId,
      branchId: ledger.branchId,
      entityType: 'inventoryBatchUsageLedger',
      entityId: ledger.id,
      operation: 'delete',
      sourceDeviceId: params.sourceDeviceId ?? null,
      payload: { id: ledger.id },
    })

    restoredByIngredient.set(
      ledger.ingredientId,
      roundQuantity((restoredByIngredient.get(ledger.ingredientId) ?? 0) + ledger.quantityConsumed),
    )
  }

  for (const [ingredientId, restoredQuantity] of restoredByIngredient) {
    await db.inventoryItem.updateMany({
      where: { id: ingredientId, restaurantId: params.restaurantId },
      data: { quantity: { increment: restoredQuantity } },
    })
    const resynced = await syncItemActiveUnitCostAfterChange(db, {
      restaurantId: params.restaurantId,
      branchId: log.branchId,
      ingredientId,
    })
    if (resynced) {
      await enqueueSyncChange(db, {
        restaurantId: params.restaurantId,
        branchId: log.branchId,
        entityType: 'inventoryItem',
        entityId: resynced.id,
        operation: 'upsert',
        sourceDeviceId: params.sourceDeviceId ?? null,
        payload: resynced,
      })
    }
  }

  const reversedLog = await db.prepLog.update({
    where: { id: log.id },
    data: { reversedAt: new Date() },
  })
  await enqueueSyncChange(db, {
    restaurantId: params.restaurantId,
    branchId: log.branchId,
    entityType: 'prepLog',
    entityId: reversedLog.id,
    operation: 'upsert',
    sourceDeviceId: params.sourceDeviceId ?? null,
    payload: reversedLog,
  })

  return { ok: true, remaining: await currentRemaining() }
}
