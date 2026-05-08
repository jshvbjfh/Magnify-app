import type { Prisma, PrismaClient } from '@prisma/client'

import { recordJournalEntry } from '@/lib/accounting'
import { consumeIngredientStock, getRestaurantFifoEnabled, InsufficientFifoStockError, InsufficientInventoryStockError } from '@/lib/inventoryConsumption'
import { enqueueSyncChange } from '@/lib/syncOutbox'

type PrismaDb = PrismaClient | Prisma.TransactionClient

type SaleLineInput = {
  dishId: string
  dishPrice: number
  qty: number
}

type WasteLineInput = {
  dishId: string
  dishName: string
  qty: number
}

export { InsufficientFifoStockError, InsufficientInventoryStockError } from '@/lib/inventoryConsumption'

function roundQuantity(value: number) {
  return Math.round(value * 1000) / 1000
}

function buildRestaurantScopedDishWhere(params: {
  requestedDishIds: string[]
  billingUserId: string
  restaurantId?: string | null
  branchId?: string | null
  includeBranchlessRows?: boolean
}) {
  return {
    id: { in: params.requestedDishIds },
    ...(params.restaurantId
      ? { restaurantId: params.restaurantId }
      : { userId: params.billingUserId }),
    // Dish.branchId is non-null in the schema, so dish lookups must always use a
    // concrete branchId instead of OR-ing in branchless rows.
    ...(params.branchId ? { branchId: params.branchId } : {}),
  }
}

export async function recordDishSalesForPaidOrder(
  db: PrismaDb,
  params: {
    billingUserId: string
    restaurantId?: string | null
    branchId?: string | null
    includeBranchlessRows?: boolean
    sourceDeviceId?: string | null
    orderId?: string | null
    paymentMethod?: string | null
    saleDate: Date
    items: SaleLineInput[]
  }
) {
  if (params.items.length === 0) return
  if (!params.restaurantId || !params.branchId) {
    throw new Error('recordDishSalesForPaidOrder requires restaurantId and branchId')
  }
  const fifoEnabled = await getRestaurantFifoEnabled(db, {
    billingUserId: params.billingUserId,
    restaurantId: params.restaurantId,
  })
  const requestedDishIds = Array.from(new Set(params.items.map((item) => item.dishId)))
  const dishes = await db.dish.findMany({
    where: buildRestaurantScopedDishWhere({
      requestedDishIds,
      billingUserId: params.billingUserId,
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      includeBranchlessRows: params.includeBranchlessRows,
    }),
    include: {
      ingredients: {
        include: {
          ingredient: true,
        },
      },
    },
  })

  const dishMap = new Map(dishes.map((dish) => [dish.id, dish]))

  for (const item of params.items) {
    const dish = dishMap.get(item.dishId)
    if (!dish) {
      // Dish missing on cloud (not yet synced from local device). Skip COGS/inventory
      // recording for this item — revenue is still captured via the journal entry in
      // finalizeRestaurantOrderPayment. Throwing here rolls back the entire push
      // transaction and traps the order in an infinite retry loop.
      console.warn(`[dishSale] dish ${item.dishId} not found on cloud — skipping COGS for this item (order: ${params.orderId ?? 'unknown'})`)
      continue
    }

    const quantitySold = Number(item.qty) || 0
    if (quantitySold <= 0) continue

    // Idempotency guard: skip this dish line if already recorded for this order.
    // Checked per dish (not per order) so a partial-failure retry can fill in
    // the remaining lines without silently skipping them.
    if (params.orderId) {
      const existingSale = await db.dishSale.findFirst({
        where: { orderId: params.orderId, dishId: item.dishId },
      })
      if (existingSale) continue
    }

    const totalSaleAmount = Number(item.dishPrice) * quantitySold
    const dishSale = await db.dishSale.create({
      data: {
        userId: params.billingUserId,
        restaurantId: params.restaurantId ?? null,
        branchId: params.branchId ?? null,
        orderId: params.orderId ?? null,
        dishId: item.dishId,
        quantitySold,
        saleDate: params.saleDate,
        paymentMethod: params.paymentMethod || 'Cash',
        totalSaleAmount,
        calculatedFoodCost: 0,
      },
    })

    let calculatedFoodCost = 0
    const ingredientLines: Array<{ ingredientId: string; quantityUsed: number; actualCost: number }> = []

    for (const row of dish.ingredients) {
      const quantityRequired = Number(row.quantityRequired || 0)
      if (!Number.isFinite(quantityRequired) || quantityRequired <= 0) {
        console.warn(`[dishSale] ingredient ${row.ingredientId} has invalid quantityRequired=${row.quantityRequired} for dish ${dish.id} — skipping COGS for this ingredient (order: ${params.orderId ?? 'unknown'})`)
        continue
      }

      const totalNeeded = roundQuantity(quantityRequired * quantitySold)
      try {
        const consumption = await consumeIngredientStock(db, {
          billingUserId: params.billingUserId,
          restaurantId: params.restaurantId,
          branchId: params.branchId,
          includeBranchlessRows: params.includeBranchlessRows,
          ingredientId: row.ingredientId,
          quantity: totalNeeded,
          fifoEnabled,
          sourceType: 'dishSale',
          sourceId: dishSale.id,
          consumedAt: params.saleDate,
          reason: params.orderId
            ? `Dish sale consumption for paid order ${params.orderId}`
            : 'Dish sale consumption',
        })

        calculatedFoodCost = roundQuantity(calculatedFoodCost + consumption.totalCost)
        ingredientLines.push({
          ingredientId: row.ingredientId,
          quantityUsed: consumption.quantityConsumed,
          actualCost: consumption.totalCost,
        })
      } catch (stockError) {
        if (stockError instanceof InsufficientFifoStockError || stockError instanceof InsufficientInventoryStockError) {
          // Skip this ingredient — insufficient stock should not block the sale
          continue
        }
        // Ingredient not found on cloud (not yet synced from local device) — skip COGS
        // for this ingredient rather than crashing the entire push transaction.
        const isIngredientNotFound = stockError instanceof Error && stockError.message.startsWith('Ingredient ')
        if (isIngredientNotFound) {
          console.warn(`[dishSale] ingredient not found on cloud — skipping COGS for ingredient ${row.ingredientId} (order: ${params.orderId ?? 'unknown'})`)
          continue
        }

        const isInvalidIngredientQuantity = stockError instanceof Error && stockError.message === 'Ingredient consumption quantity must be greater than 0.'
        if (isInvalidIngredientQuantity) {
          console.warn(`[dishSale] ingredient ${row.ingredientId} resolved to non-positive consumption — skipping COGS for this ingredient (order: ${params.orderId ?? 'unknown'})`)
          continue
        }

        throw stockError
      }
    }

    const updatedDishSale = await db.dishSale.update({
      where: { id: dishSale.id },
      data: ingredientLines.length > 0
        ? {
            calculatedFoodCost,
            saleIngredients: {
              create: ingredientLines,
            },
          }
        : {
            calculatedFoodCost,
          },
    })

    const saleIngredients = await db.dishSaleIngredient.findMany({
      where: { dishSaleId: dishSale.id },
      orderBy: { id: 'asc' },
    })

    await enqueueSyncChange(db, {
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      entityType: 'dishSale',
      entityId: updatedDishSale.id,
      operation: 'upsert',
      sourceDeviceId: params.sourceDeviceId ?? null,
      payload: {
        ...updatedDishSale,
        saleIngredients,
      },
    })
  }
}

export async function recordDishWasteForOrderItems(
  db: PrismaDb,
  params: {
    billingUserId: string
    restaurantId?: string | null
    branchId?: string | null
    includeBranchlessRows?: boolean
    orderId?: string | null
    orderLabel?: string | null
    wasteDate: Date
    reason: string
    items: WasteLineInput[]
  }
) {
  if (params.items.length === 0) return []
  if (!params.restaurantId || !params.branchId) {
    throw new Error('recordDishWasteForOrderItems requires restaurantId and branchId')
  }
  const fifoEnabled = await getRestaurantFifoEnabled(db, {
    billingUserId: params.billingUserId,
    restaurantId: params.restaurantId,
  })
  const requestedDishIds = Array.from(new Set(params.items.map((item) => item.dishId)))
  const dishes = await db.dish.findMany({
    where: buildRestaurantScopedDishWhere({
      requestedDishIds,
      billingUserId: params.billingUserId,
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      includeBranchlessRows: params.includeBranchlessRows,
    }),
    include: {
      ingredients: {
        include: {
          ingredient: {
            select: {
              id: true,
              name: true,
              unit: true,
              unitCost: true,
              quantity: true,
            },
          },
        },
      },
    },
  })

  const dishMap = new Map(dishes.map((dish) => [dish.id, dish]))
  const wasteByIngredient = new Map<string, {
    ingredientId: string
    ingredientName: string
    ingredientSnapshot: {
      id: string
      name: string
      unit: string
      unitCost: number | null
      quantity: number
    }
    quantityWasted: number
  }>()
  const dishSummary: string[] = []

  for (const item of params.items) {
    const dish = dishMap.get(item.dishId)
    if (!dish) {
      throw new Error(`Dish ${item.dishId} is missing and cannot be recorded as waste.`)
    }

    const quantityWasted = Number(item.qty) || 0
    if (quantityWasted <= 0) continue

    dishSummary.push(`${item.dishName} x${quantityWasted}`)

    for (const row of dish.ingredients) {
      const totalNeeded = roundQuantity(row.quantityRequired * quantityWasted)
      if (totalNeeded <= 0) continue

      const existing = wasteByIngredient.get(row.ingredientId)
      if (existing) {
        existing.quantityWasted = roundQuantity(existing.quantityWasted + totalNeeded)
        continue
      }

      wasteByIngredient.set(row.ingredientId, {
        ingredientId: row.ingredientId,
        ingredientName: row.ingredient.name,
        ingredientSnapshot: {
          id: row.ingredient.id,
          name: row.ingredient.name,
          unit: row.ingredient.unit,
          unitCost: row.ingredient.unitCost,
          quantity: Number(row.ingredient.quantity || 0),
        },
        quantityWasted: totalNeeded,
      })
    }
  }

  if (wasteByIngredient.size === 0) return []

  const wasteReason = String(params.reason || '').trim() || 'Marked as wasted'
  const orderContext = params.orderLabel?.trim()
    ? `Prepared dish waste for ${params.orderLabel.trim()}`
    : params.orderId
      ? `Prepared dish waste for order ${params.orderId}`
      : 'Prepared dish waste'
  const wasteNotes = dishSummary.length > 0
    ? `${orderContext}: ${dishSummary.join(', ')}`
    : orderContext
  const finalizedLogs = []

  for (const waste of wasteByIngredient.values()) {
    const createdLog = await db.wasteLog.create({
      data: {
        userId: params.billingUserId,
        restaurantId: params.restaurantId ?? null,
        branchId: params.branchId ?? null,
        ingredientId: waste.ingredientId,
        quantityWasted: waste.quantityWasted,
        reason: wasteReason,
        notes: wasteNotes,
        date: params.wasteDate,
        calculatedCost: 0,
      },
    })

    const consumption = await consumeIngredientStock(db, {
      billingUserId: params.billingUserId,
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      includeBranchlessRows: params.includeBranchlessRows,
      ingredientId: waste.ingredientId,
      quantity: waste.quantityWasted,
      fifoEnabled,
      sourceType: 'waste',
      sourceId: createdLog.id,
      consumedAt: params.wasteDate,
      reason: `${orderContext}: ${wasteReason}`,
      ingredientSnapshot: waste.ingredientSnapshot,
    })

    await recordJournalEntry(db, {
      userId: params.billingUserId,
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      date: params.wasteDate,
      description: `Waste: ${waste.ingredientName} - ${wasteReason}${params.orderLabel ? ` (${params.orderLabel})` : ''}`,
      amount: consumption.totalCost,
      direction: 'out',
      accountName: 'Waste & Spoilage',
      categoryType: 'expense',
      paymentMethod: 'Internal',
      counterAccountName: 'Inventory',
      counterCategoryType: 'asset',
      counterAccountType: 'asset',
      isManual: false,
      sourceKind: 'inventory_waste',
    })

    const finalizedLog = await db.wasteLog.update({
      where: { id: createdLog.id },
      data: {
        calculatedCost: consumption.totalCost,
      },
    })

    await enqueueSyncChange(db, {
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      entityType: 'wasteLog',
      entityId: finalizedLog.id,
      operation: 'upsert',
      payload: finalizedLog,
    })

    finalizedLogs.push(finalizedLog)
  }

  return finalizedLogs
}