import type { Prisma, PrismaClient } from '@prisma/client'

import { recordJournalEntry } from '@/lib/accounting'
import { isHotelBuffetLine } from '@/lib/hotelBuffet'
import { consumeIngredientStock, getRestaurantFifoEnabled, getRestaurantSharedStock, InsufficientFifoStockError, InsufficientInventoryStockError } from '@/lib/inventoryConsumption'
import { consumePrepAwareIngredient } from '@/lib/mepProduction'
import { enqueueSyncChange } from '@/lib/syncOutbox'

type PrismaDb = PrismaClient | Prisma.TransactionClient

type SaleLineInput = {
  orderItemId?: string | null
  dishId: string
  dishName?: string | null
  dishVariantId?: string | null
  dishVariantName?: string | null
  dishPrice: number
  qty: number
  // Station the item was rung up under, snapshotted at order-creation time.
  // Preferred over the dish's live branchId so a mid-order station reassignment
  // can't retroactively misattribute an already-open order's sale.
  branchId?: string | null
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

export async function recordDishSalesForPaidOrder(
  db: PrismaDb,
  params: {
    restaurantId: string
    branchId: string
    sourceDeviceId?: string | null
    orderId?: string | null
    paymentMethod?: string | null
    saleDate: Date
    // The shift's business day this sale is attributed to (null = no shift; the
    // sale falls back to saleDate in reports).
    businessDate?: Date | null
    items: SaleLineInput[]
  }
) {
  if (params.items.length === 0) return

  const fifoEnabled = getRestaurantFifoEnabled()
  // Read once for the whole sale rather than per ingredient line.
  const sharedStock = await getRestaurantSharedStock(db, params.restaurantId)
  const requestedDishIds = Array.from(new Set(params.items.map((item) => item.dishId)))
  // Look up dishes across ALL branches by restaurantId — each dish carries its own branchId.
  // Do NOT filter by params.branchId here: an order can contain dishes from multiple branches.
  const dishes = await db.dish.findMany({
    where: {
      id: { in: requestedDishIds },
      restaurantId: params.restaurantId,
    },
    include: {
      ingredients: {
        include: {
          inventoryItem: {
            include: {
              prepIngredients: {
                include: { ingredient: true },
              },
            },
          },
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

    // Idempotency guard: prefer order-item granularity so one order can safely
    // contain the same parent dish more than once with different sizes.
    if (item.orderItemId) {
      const existingSale = await db.dishSale.findFirst({
        where: { orderItemId: item.orderItemId },
      })
      if (existingSale) continue
    } else if (params.orderId) {
      const existingSale = await db.dishSale.findFirst({
        where: { orderId: params.orderId, dishId: item.dishId },
      })
      if (existingSale) continue
    }

    // Prefer the item's own station snapshot (taken when it was added to the order)
    // over the dish's live branchId — a dish reassigned to a different station while
    // this order sat open/unpaid must not retroactively change where it was rung up.
    // Falls back to the dish's current branchId, then the till's, for legacy rows with
    // no snapshot.
    const dishBranchId = item.branchId ?? dish.branchId ?? params.branchId

    const totalSaleAmount = Number(item.dishPrice) * quantitySold
    const dishSale = await db.dishSale.create({
      data: {
        restaurantId: params.restaurantId,
        branchId: dishBranchId,
        orderId: params.orderId ?? null,
        orderItemId: item.orderItemId ?? null,
        dishId: item.dishId,
        dishVariantId: item.dishVariantId ?? null,
        dishVariantName: item.dishVariantName ?? null,
        dishName: item.dishName?.trim() || dish.name,
        quantitySold,
        saleDate: params.saleDate,
        businessDate: params.businessDate ?? null,
        // The hotel buffet is owed by the hotel, not tendered at the table, so
        // its sale row carries 'Credit' whatever the guest paid their add-ons
        // with — otherwise sales-by-tender reports would count the receivable
        // as cash in the drawer. Matches the journal split in
        // finalizeRestaurantOrderPayment.
        paymentMethod: isHotelBuffetLine(item.dishName ?? dish.name, dish.category)
          ? 'Credit'
          : (params.paymentMethod || 'Cash'),
        totalSaleAmount,
        calculatedFoodCost: 0,
      },
    })

    let calculatedFoodCost = 0
    const ingredientLines: Array<{ ingredientId: string; quantityUsed: number; actualCost: number }> = []

    // MEP-FIRST (dish level): batch-cooked portions cover the sale before the
    // recipe runs. Re-read live counters — the same dish can appear on multiple
    // lines of this order, so dishMap's copy may already be stale.
    let recipeQuantity = quantitySold
    const freshDish = await db.dish.findUnique({
      where: { id: dish.id },
      select: { preparedPortions: true, preparedPortionCost: true },
    })
    const portionsAvailable = Math.max(0, roundQuantity(Number(freshDish?.preparedPortions ?? 0)))
    const portionsUsed = roundQuantity(Math.min(portionsAvailable, quantitySold))
    if (portionsUsed > 0) {
      calculatedFoodCost = roundQuantity(calculatedFoodCost + portionsUsed * Number(freshDish?.preparedPortionCost ?? 0))
      recipeQuantity = roundQuantity(quantitySold - portionsUsed)

      const updatedDish = await db.dish.update({
        where: { id: dish.id },
        data: { preparedPortions: roundQuantity(Math.max(0, portionsAvailable - portionsUsed)) },
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
    }

    for (const row of dish.ingredients) {
      if (recipeQuantity <= 0) break

      const quantityRequired = Number(row.quantityRequired || 0)
      if (!Number.isFinite(quantityRequired) || quantityRequired <= 0) {
        console.warn(`[dishSale] ingredient ${row.inventoryItemId} has invalid quantityRequired=${row.quantityRequired} for dish ${dish.id} — skipping COGS for this ingredient (order: ${params.orderId ?? 'unknown'})`)
        continue
      }

      const totalNeeded = roundQuantity(quantityRequired * recipeQuantity)
      try {
        if (row.inventoryItem.type === 'prep' && row.inventoryItem.prepIngredients.length > 0) {
          // MEP-FIRST (prep level): drain the prep's own kitchen-made stock, then
          // cascade only the uncovered shortfall to raw ingredients. The old code
          // consumed both unconditionally, double-counting whenever the prep held stock.
          const prepConsumption = await consumePrepAwareIngredient(db, {
            restaurantId: params.restaurantId,
            branchId: dishBranchId,
            sharedStock,
            ingredient: row.inventoryItem,
            quantityNeeded: totalNeeded,
            fifoEnabled,
            sourceType: 'dishSale',
            sourceId: dishSale.id,
            consumedAt: params.saleDate,
            reason: params.orderId
              ? `Dish sale consumption for paid order ${params.orderId}`
              : 'Dish sale consumption',
          })
          calculatedFoodCost = roundQuantity(calculatedFoodCost + prepConsumption.totalCost)
          ingredientLines.push(...prepConsumption.lines.map((line) => ({
            ingredientId: line.ingredientId,
            quantityUsed: line.quantityUsed,
            actualCost: line.actualCost,
          })))
          for (const warning of prepConsumption.warnings) {
            console.warn(`[dishSale] ${warning} — ${dish.name} (order: ${params.orderId ?? 'unknown'})`)
          }
        } else {
          const consumption = await consumeIngredientStock(db, {
            restaurantId: params.restaurantId,
            branchId: dishBranchId,
            sharedStock,
            ingredientId: row.inventoryItemId,
            quantity: totalNeeded,
            fifoEnabled,
            sourceType: 'dishSale',
            sourceId: dishSale.id,
            consumedAt: params.saleDate,
            reason: params.orderId
              ? `Dish sale consumption for paid order ${params.orderId}`
              : 'Dish sale consumption',
            allowPartial: true,
          })

          calculatedFoodCost = roundQuantity(calculatedFoodCost + consumption.totalCost)
          if (consumption.quantityConsumed > 0) {
            ingredientLines.push({
              ingredientId: row.inventoryItemId,
              quantityUsed: consumption.quantityConsumed,
              actualCost: consumption.totalCost,
            })
          }
          if (consumption.shortfall > 0) {
            console.warn(`[dishSale] low stock: ${row.inventoryItem.name} — used ${consumption.quantityConsumed} of ${totalNeeded} ${row.inventoryItem.unit} needed for ${dish.name} (order: ${params.orderId ?? 'unknown'})`)
          }
        }
      } catch (stockError) {
        if (stockError instanceof InsufficientFifoStockError || stockError instanceof InsufficientInventoryStockError) {
          continue
        }
        // Ingredient not found on cloud (not yet synced from local device) — skip COGS
        // for this ingredient rather than crashing the entire push transaction.
        const isIngredientNotFound = stockError instanceof Error && stockError.message.startsWith('Ingredient ')
        if (isIngredientNotFound) {
          // Under shared stock this excuse no longer holds: the pool covers the
          // whole restaurant, so a missing ingredient is a genuine fault, not a
          // device that has yet to sync. Swallowing it here is what would let a
          // station sell all night deducting nothing and booking zero cost, so
          // it is logged as an error loudly enough to be found.
          console[sharedStock ? 'error' : 'warn'](
            sharedStock
              ? `[dishSale] SHARED STOCK: ingredient ${row.inventoryItemId} not found anywhere in restaurant ${params.restaurantId} — no stock deducted and no cost recorded for ${dish.name} (order: ${params.orderId ?? 'unknown'})`
              : `[dishSale] ingredient not found on cloud — skipping COGS for ingredient ${row.inventoryItemId} (order: ${params.orderId ?? 'unknown'})`
          )
          continue
        }

        const isInvalidIngredientQuantity = stockError instanceof Error && stockError.message === 'Ingredient consumption quantity must be greater than 0.'
        if (isInvalidIngredientQuantity) {
          console.warn(`[dishSale] ingredient ${row.inventoryItemId} resolved to non-positive consumption — skipping COGS for this ingredient (order: ${params.orderId ?? 'unknown'})`)
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
      branchId: dishBranchId,
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
    restaurantId: string
    branchId: string
    orderId?: string | null
    orderLabel?: string | null
    wasteDate: Date
    reason: string
    items: WasteLineInput[]
  }
) {
  if (params.items.length === 0) return []

  const fifoEnabled = getRestaurantFifoEnabled()
  // Waste draws on the same pool a sale does, so it has to resolve stock the
  // same way — otherwise writing off a spilled item would silently find nothing.
  const sharedStock = await getRestaurantSharedStock(db, params.restaurantId)
  const requestedDishIds = Array.from(new Set(params.items.map((item) => item.dishId)))
  const dishes = await db.dish.findMany({
    where: { id: { in: requestedDishIds }, restaurantId: params.restaurantId },
    include: {
      ingredients: {
        include: {
          inventoryItem: {
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

      const existing = wasteByIngredient.get(row.inventoryItemId)
      if (existing) {
        existing.quantityWasted = roundQuantity(existing.quantityWasted + totalNeeded)
        continue
      }

      wasteByIngredient.set(row.inventoryItemId, {
        ingredientId: row.inventoryItemId,
        ingredientName: row.inventoryItem.name,
        ingredientSnapshot: {
          id: row.inventoryItem.id,
          name: row.inventoryItem.name,
          unit: row.inventoryItem.unit,
          unitCost: row.inventoryItem.unitCost,
          quantity: Number(row.inventoryItem.quantity || 0),
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
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        ingredientId: waste.ingredientId,
        quantityWasted: waste.quantityWasted,
        reason: wasteReason,
        notes: wasteNotes,
        date: params.wasteDate,
        calculatedCost: 0,
      },
    })

    const consumption = await consumeIngredientStock(db, {
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      sharedStock,
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
    })

    const finalizedLog = await db.wasteLog.update({
      where: { id: createdLog.id },
      data: { calculatedCost: consumption.totalCost },
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
