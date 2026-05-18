import type { Prisma, PrismaClient, SyncOutbox } from '.prisma/client'

import {
  getSyncDeviceId,
  logSyncConflict,
  isRestaurantWideSyncEntity,
  serializeOutboxPayload,
  type SyncChangeEnvelope,
} from '@/lib/syncOutbox'

type PrismaDb = PrismaClient | Prisma.TransactionClient

function asDate(value: unknown) {
  if (!value) return null
  const parsed = new Date(String(value))
  return Number.isNaN(parsed.getTime()) ? null : parsed
}


/**
 * Resolve a branchId for entities (dishes, tables) that must never have a null
 * branchId in a post-migration database.  If the payload carries no branchId,
 * look up the restaurant's main (isMain=true) branch and use that instead.
 *
 * Returns null only when the restaurant itself has no branch records at all,
 * which is a data integrity error that must be logged and investigated.
 */
async function resolveSyncBranchId(
  db: PrismaDb,
  payloadBranchId: unknown,
  restaurantId: unknown,
  entityType: string,
  entityId: string,
): Promise<string | null> {
  const candidate = String(payloadBranchId ?? '').trim()
  if (candidate) return candidate

  const resId = String(restaurantId ?? '').trim()
  if (!resId) {
    console.error(
      '[syncEngine] %s %s has no branchId and no restaurantId — cannot resolve branch',
      entityType, entityId,
    )
    return null
  }

  // Try the main branch first, then any active branch as a fallback.
  const branch =
    await (db as PrismaClient).branch.findFirst({
      where: { restaurantId: resId, isMain: true, isActive: true },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    }) ??
    await (db as PrismaClient).branch.findFirst({
      where: { restaurantId: resId, isActive: true },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    })

  if (branch) {
    console.warn(
      '[syncEngine] %s %s missing branchId in payload — resolved to branch %s for restaurant %s',
      entityType, entityId, branch.id, resId,
    )
    return branch.id
  }

  console.error(
    '[syncEngine] %s %s missing branchId and restaurant %s has no active branches — skipping upsert',
    entityType, entityId, resId,
  )
  return null
}

async function hasPendingLocalConflict(db: PrismaDb, change: SyncChangeEnvelope, localDeviceId: string) {
  const pending = await db.syncOutbox.findFirst({
    where: {
      scopeId: change.scopeId,
      entityType: change.entityType,
      entityId: change.entityId,
      syncedAt: null,
      mutationId: { not: change.mutationId },
    },
  })

  if (!pending) return null
  if ((change.sourceDeviceId || null) === localDeviceId) return null
  return pending
}

export async function applyResolvedSyncChange(db: PrismaDb, change: SyncChangeEnvelope, options?: { remapUserId?: string; idRemap?: Map<string, string> }) {
  const payload = (change.payload ?? {}) as Record<string, any>

  // When syncing to cloud, use the authenticated cloud user's id as the restaurant owner.
  const ownerId = options?.remapUserId ?? payload.ownerId

  switch (change.entityType) {
    case 'restaurant': {
      const incomingRestaurantId = String(payload.id || change.entityId)

      // Pre-upsert conflict resolution for joinCode @unique (same pattern as C1 for dish/inventoryItem).
      // If a different restaurant row on the cloud already owns payload.joinCode, displace its joinCode
      // so our upsert can claim it. The conflicting row is a ghost/phantom (S1 class) — a real active
      // restaurant would have been the one sending the sync payload, not the one blocking it.
      if (payload.joinCode) {
        const joinCodeConflict = await db.restaurant.findFirst({
          where: { joinCode: payload.joinCode, NOT: { id: incomingRestaurantId } },
          select: { id: true },
        })
        if (joinCodeConflict) {
          await db.restaurant.update({
            where: { id: joinCodeConflict.id },
            data: { joinCode: `DISPLACED-${joinCodeConflict.id.slice(-8)}` },
          })
        }
      }

      await db.restaurant.upsert({
        where: { id: incomingRestaurantId },
        update: {
          name: payload.name,
          ownerId: ownerId,
          joinCode: payload.joinCode,
          billHeader: payload.billHeader ?? '',
          licenseExpiry: asDate(payload.licenseExpiry),
          licenseActive: Boolean(payload.licenseActive),
          createdAt: asDate(payload.createdAt) ?? undefined,
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
        create: {
          id: String(payload.id || change.entityId),
          name: payload.name,
          ownerId: ownerId,
          joinCode: payload.joinCode,
          billHeader: payload.billHeader ?? '',
          licenseExpiry: asDate(payload.licenseExpiry),
          licenseActive: payload.licenseActive == null ? true : Boolean(payload.licenseActive),
          createdAt: asDate(payload.createdAt) ?? new Date(),
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
      })
      break
    }
    case 'branch': {
      if (change.operation === 'delete') {
        await db.branch.deleteMany({ where: { id: change.entityId } })
        break
      }

      // Before upserting, delete any cloud-auto-created "ghost" branch that shares the same
      // restaurantId+code or restaurantId+name but a different id.  Ghost branches are created
      // by ensureMainBranchForRestaurant before entity-sync applies and violate the unique
      // constraints @@unique([restaurantId, code]) / @@unique([restaurantId, name]),
      // causing the entire sync transaction to roll back so no data ever reaches the owner.
      {
        const incomingId = String(payload.id || change.entityId)
        const incomingCode = String(payload.code ?? '').trim()
        const incomingName = String(payload.name ?? '').trim()
        const incomingRestaurantId = String(payload.restaurantId ?? '').trim()
        if (incomingRestaurantId) {
          const conflictFilter: Array<{ code: string } | { name: string }> = []
          if (incomingCode) conflictFilter.push({ code: incomingCode })
          if (incomingName) conflictFilter.push({ name: incomingName })
          if (conflictFilter.length > 0) {
            await db.branch.deleteMany({
              where: {
                id: { not: incomingId },
                restaurantId: incomingRestaurantId,
                OR: conflictFilter,
              },
            })
          }
        }
      }

      await db.branch.upsert({
        where: { id: String(payload.id || change.entityId) },
        update: {
          restaurantId: payload.restaurantId,
          name: payload.name,
          code: payload.code ?? String(payload.name ?? '').slice(0, 8).toUpperCase(),
          isMain: Boolean(payload.isMain),
          isActive: payload.isActive == null ? true : Boolean(payload.isActive),
          createdAt: asDate(payload.createdAt) ?? undefined,
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
        create: {
          id: String(payload.id || change.entityId),
          restaurantId: payload.restaurantId,
          name: payload.name,
          code: payload.code ?? String(payload.name ?? '').slice(0, 8).toUpperCase(),
          isMain: Boolean(payload.isMain),
          isActive: payload.isActive == null ? true : Boolean(payload.isActive),
          createdAt: asDate(payload.createdAt) ?? new Date(),
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
      })
      break
    }
    case 'restaurantTable': {
      if (change.operation === 'delete') {
        await db.restaurantTable.deleteMany({ where: { id: change.entityId } })
        break
      }

      // Same null-branchId guard as for dishes — tables without a branch are
      // invisible to the waiter pull query.
      const tableBranchId = await resolveSyncBranchId(
        db, payload.branchId, payload.restaurantId, 'restaurantTable', change.entityId,
      )
      // C-branchskip: throw so applyIncomingSyncChanges records to failedChanges instead
      // of silently counting this as applied while data was never written.
      if (!tableBranchId) throw new Error(`[syncEngine] restaurantTable:${change.entityId} — no resolvable branchId; restaurant has no active branches`)

      await db.restaurantTable.upsert({
        where: { id: String(payload.id || change.entityId) },
        update: {
          restaurantId: payload.restaurantId,
          branchId: tableBranchId,
          name: payload.name,
          seats: Number(payload.seats ?? 4),
          status: payload.status ?? 'available',
          createdAt: asDate(payload.createdAt) ?? undefined,
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
        create: {
          id: String(payload.id || change.entityId),
          restaurantId: payload.restaurantId,
          branchId: tableBranchId,
          name: payload.name,
          seats: Number(payload.seats ?? 4),
          status: payload.status ?? 'available',
          createdAt: asDate(payload.createdAt) ?? new Date(),
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
      })
      break
    }
    case 'pricingPlan': {
      // PricingPlan model removed — silently skip to avoid breaking old sync payloads
      break
    }
    case 'dish': {
      if (change.operation === 'delete') {
        await db.dish.deleteMany({ where: { id: change.entityId } })
        break
      }

      const dishBranchId = await resolveSyncBranchId(
        db, payload.branchId, payload.restaurantId, 'dish', change.entityId,
      )
      if (!dishBranchId) throw new Error(`[syncEngine] dish:${change.entityId} — no resolvable branchId; restaurant has no active branches`)

      // C1: If a dish with the same (restaurantId, branchId, name) exists under a different id,
      // update that row instead of upsert-by-id to avoid @@unique([restaurantId,branchId,name]) violation.
      const incomingDishId = String(payload.id || change.entityId)
      const dishConflict = await db.dish.findFirst({
        where: { restaurantId: payload.restaurantId ?? null, branchId: dishBranchId, name: payload.name, NOT: { id: incomingDishId } },
        select: { id: true },
      })
      const dishTargetId = dishConflict?.id ?? incomingDishId
      if (options?.idRemap && dishTargetId !== incomingDishId) {
        options.idRemap.set(incomingDishId, dishTargetId)
      }

      await db.dish.upsert({
        where: { id: dishTargetId },
        update: {
          restaurantId: payload.restaurantId ?? null,
          branchId: dishBranchId,
          name: payload.name,
          sellingPrice: Number(payload.sellingPrice),
          category: payload.category ?? null,
          isActive: payload.isActive == null ? true : Boolean(payload.isActive),
          createdAt: asDate(payload.createdAt) ?? undefined,
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
        create: {
          id: dishTargetId,
          restaurantId: payload.restaurantId ?? null,
          branchId: dishBranchId,
          name: payload.name,
          sellingPrice: Number(payload.sellingPrice),
          category: payload.category ?? null,
          isActive: payload.isActive == null ? true : Boolean(payload.isActive),
          createdAt: asDate(payload.createdAt) ?? new Date(),
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
      })
      break
    }
    case 'dishIngredient': {
      if (change.operation === 'delete') {
        const [parsedDishId, parsedItemId] = change.entityId.split(':')
        const rawDishId = String(payload.dishId || parsedDishId || '')
        const rawItemId = String(payload.inventoryItemId || payload.ingredientId || parsedItemId || '')
        const dishId = options?.idRemap?.get(rawDishId) ?? rawDishId
        const inventoryItemId = options?.idRemap?.get(rawItemId) ?? rawItemId
        if (!dishId || !inventoryItemId) {
          throw new Error(
            `[syncEngine] dishIngredient delete ${change.entityId} — cannot resolve dishId/inventoryItemId from payload or entityId`,
          )
        }
        await db.dishIngredient.deleteMany({
          where: { dishId, inventoryItemId },
        })
        break
      }

      const resolvedDishIngredientDishId = options?.idRemap?.get(String(payload.dishId)) ?? String(payload.dishId)
      const resolvedInventoryItemId = options?.idRemap?.get(String(payload.inventoryItemId ?? payload.ingredientId)) ?? String(payload.inventoryItemId ?? payload.ingredientId)

      await db.dishIngredient.upsert({
        where: {
          dishId_inventoryItemId: {
            dishId: resolvedDishIngredientDishId,
            inventoryItemId: resolvedInventoryItemId,
          },
        },
        update: { quantityRequired: Number(payload.quantityRequired) },
        create: {
          dishId: resolvedDishIngredientDishId,
          inventoryItemId: resolvedInventoryItemId,
          quantityRequired: Number(payload.quantityRequired),
        },
      })
      break
    }
    case 'employee':
    case 'staff': {
      if (change.operation === 'delete') {
        await db.staff.deleteMany({ where: { id: change.entityId } })
        break
      }

      const staffRestaurantId = String(payload.restaurantId ?? '').trim()
      const staffBranchId = await resolveSyncBranchId(
        db, payload.branchId, staffRestaurantId, 'staff', change.entityId,
      )
      if (!staffBranchId) throw new Error(`[syncEngine] staff:${change.entityId} — no resolvable branchId; restaurant has no active branches`)

      const staffTargetId = String(payload.id || change.entityId)
      await db.staff.upsert({
        where: { id: staffTargetId },
        update: {
          restaurantId: staffRestaurantId,
          name: payload.name,
          role: payload.role ?? 'waiter',
          pin: payload.pin ?? payload.cancellationPinHash ?? null,
          isActive: payload.isActive == null ? true : Boolean(payload.isActive),
          phone: payload.phone ?? null,
          createdAt: asDate(payload.createdAt) ?? undefined,
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
        create: {
          id: staffTargetId,
          restaurantId: staffRestaurantId,
          name: payload.name,
          role: payload.role ?? 'waiter',
          pin: payload.pin ?? payload.cancellationPinHash ?? null,
          isActive: payload.isActive == null ? true : Boolean(payload.isActive),
          phone: payload.phone ?? null,
          createdAt: asDate(payload.createdAt) ?? new Date(),
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
      })
      // Ensure StaffBranch association exists
      if (staffBranchId) {
        await (db as any).staffBranch.upsert({
          where: { staffId_branchId: { staffId: staffTargetId, branchId: staffBranchId } },
          update: {},
          create: { staffId: staffTargetId, branchId: staffBranchId },
        })
      }
      break
    }
    case 'transaction': {
      // Transaction model removed — journal entries are written by the accounting lib.
      // Silently skip old transaction payloads from legacy desktop devices.
      break
    }
    case 'inventoryItem': {
      if (change.operation === 'delete') {
        await db.inventoryItem.deleteMany({ where: { id: change.entityId } })
        break
      }

      const inventoryItemRestaurantId = String(payload.restaurantId ?? '').trim()
      const inventoryItemBranchId = await resolveSyncBranchId(
        db, payload.branchId, inventoryItemRestaurantId, 'inventoryItem', change.entityId,
      )
      // C-branchskip: throw so applyIncomingSyncChanges records to failedChanges.
      if (!inventoryItemBranchId) throw new Error(`[syncEngine] inventoryItem:${change.entityId} — no resolvable branchId; restaurant has no active branches`)

      // C1: If an inventoryItem with the same (restaurantId, branchId, name) exists under a
      // different id, update that row instead of upsert-by-id, avoiding the @@unique violation.
      const incomingInventoryItemId = String(payload.id || change.entityId)
      const inventoryItemConflict = await db.inventoryItem.findFirst({
        where: { restaurantId: inventoryItemRestaurantId, branchId: inventoryItemBranchId, name: payload.name, NOT: { id: incomingInventoryItemId } },
        select: { id: true },
      })
      const inventoryItemTargetId = inventoryItemConflict?.id ?? incomingInventoryItemId
      if (options?.idRemap && inventoryItemTargetId !== incomingInventoryItemId) {
        options.idRemap.set(incomingInventoryItemId, inventoryItemTargetId)
      }

      await db.inventoryItem.upsert({
        where: { id: inventoryItemTargetId },
        update: {
          restaurantId: inventoryItemRestaurantId,
          branchId: inventoryItemBranchId,
          name: payload.name,
          description: payload.description ?? null,
          unit: payload.unit,
          unitCost: payload.unitCost == null ? 0 : Number(payload.unitCost),
          quantity: Number(payload.quantity ?? 0),
          category: payload.category ?? null,
          reorderLevel: Number(payload.reorderLevel ?? 0),
          createdAt: asDate(payload.createdAt) ?? undefined,
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
        create: {
          id: inventoryItemTargetId,
          restaurantId: inventoryItemRestaurantId,
          branchId: inventoryItemBranchId,
          name: payload.name,
          description: payload.description ?? null,
          unit: payload.unit,
          unitCost: payload.unitCost == null ? 0 : Number(payload.unitCost),
          quantity: Number(payload.quantity ?? 0),
          category: payload.category ?? null,
          reorderLevel: Number(payload.reorderLevel ?? 0),
          createdAt: asDate(payload.createdAt) ?? new Date(),
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
      })
      break
    }
    case 'inventoryPurchase': {
      if (change.operation === 'delete') {
        await db.inventoryPurchase.deleteMany({ where: { id: change.entityId } })
        break
      }

      const inventoryPurchaseRestaurantId = String(payload.restaurantId ?? '').trim()
      const inventoryPurchaseBranchId = await resolveSyncBranchId(
        db, payload.branchId, inventoryPurchaseRestaurantId, 'inventoryPurchase', change.entityId,
      )
      // C-branchskip: throw so applyIncomingSyncChanges records to failedChanges.
      if (!inventoryPurchaseBranchId) throw new Error(`[syncEngine] inventoryPurchase:${change.entityId} — no resolvable branchId; restaurant has no active branches`)

      const resolvedIngredientIdForPurchase = options?.idRemap?.get(String(payload.ingredientId)) ?? String(payload.ingredientId)

      await db.inventoryPurchase.upsert({
        where: { id: String(payload.id || change.entityId) },
        update: {
          restaurantId: inventoryPurchaseRestaurantId,
          branchId: inventoryPurchaseBranchId,
          ingredientId: resolvedIngredientIdForPurchase,
          supplier: payload.supplier ?? null,
          quantityPurchased: Number(payload.quantityPurchased),
          remainingQuantity: Number(payload.remainingQuantity),
          unitCost: Number(payload.unitCost),
          totalCost: Number(payload.totalCost),
          paymentMethod: payload.paymentMethod ?? 'Cash',
          purchasedAt: asDate(payload.purchasedAt) ?? new Date(),
          createdAt: asDate(payload.createdAt) ?? undefined,
        },
        create: {
          id: String(payload.id || change.entityId),
          restaurantId: inventoryPurchaseRestaurantId,
          branchId: inventoryPurchaseBranchId,
          ingredientId: resolvedIngredientIdForPurchase,
          supplier: payload.supplier ?? null,
          quantityPurchased: Number(payload.quantityPurchased),
          remainingQuantity: Number(payload.remainingQuantity),
          unitCost: Number(payload.unitCost),
          totalCost: Number(payload.totalCost),
          paymentMethod: payload.paymentMethod ?? 'Cash',
          purchasedAt: asDate(payload.purchasedAt) ?? new Date(),
          createdAt: asDate(payload.createdAt) ?? new Date(),
        },
      })
      break
    }
    case 'inventoryAdjustmentLog': {
      if (change.operation === 'delete') {
        await db.inventoryAdjustmentLog.deleteMany({ where: { id: change.entityId } })
        break
      }

      const adjustmentRestaurantId = String(payload.restaurantId ?? '').trim()
      const adjustmentBranchId = await resolveSyncBranchId(
        db, payload.branchId, adjustmentRestaurantId, 'inventoryAdjustmentLog', change.entityId,
      )
      // C-branchskip: throw so applyIncomingSyncChanges records to failedChanges.
      if (!adjustmentBranchId) throw new Error(`[syncEngine] inventoryAdjustmentLog:${change.entityId} — no resolvable branchId; restaurant has no active branches`)

      // Resolve ingredientId via batch remap in case the parent inventoryItem was C1-displaced.
      const resolvedIngredientIdForAdjustment = options?.idRemap?.get(String(payload.ingredientId)) ?? String(payload.ingredientId)

      await db.inventoryAdjustmentLog.upsert({
        where: { id: String(payload.id || change.entityId) },
        update: {
          restaurantId: adjustmentRestaurantId,
          branchId: adjustmentBranchId,
          ingredientId: resolvedIngredientIdForAdjustment,
          adjustmentType: payload.adjustmentType,
          quantityDelta: Number(payload.quantityDelta),
          itemQuantityBefore: Number(payload.itemQuantityBefore),
          itemQuantityAfter: Number(payload.itemQuantityAfter),
          reason: payload.reason ?? null,
          createdAt: asDate(payload.createdAt) ?? undefined,
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
        create: {
          id: String(payload.id || change.entityId),
          restaurantId: adjustmentRestaurantId,
          branchId: adjustmentBranchId,
          ingredientId: resolvedIngredientIdForAdjustment,
          adjustmentType: payload.adjustmentType,
          quantityDelta: Number(payload.quantityDelta),
          itemQuantityBefore: Number(payload.itemQuantityBefore),
          itemQuantityAfter: Number(payload.itemQuantityAfter),
          reason: payload.reason ?? null,
          createdAt: asDate(payload.createdAt) ?? new Date(),
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
      })
      break
    }
    case 'inventoryBatchUsageLedger': {
      if (change.operation === 'delete') {
        await db.inventoryBatchUsageLedger.deleteMany({ where: { id: change.entityId } })
        break
      }

      const batchUsageRestaurantId = String(payload.restaurantId ?? '').trim()
      const batchUsageBranchId = await resolveSyncBranchId(
        db, payload.branchId, batchUsageRestaurantId, 'inventoryBatchUsageLedger', change.entityId,
      )
      // C-branchskip: throw so applyIncomingSyncChanges records to failedChanges.
      if (!batchUsageBranchId) throw new Error(`[syncEngine] inventoryBatchUsageLedger:${change.entityId} — no resolvable branchId; restaurant has no active branches`)

      // Resolve ingredientId via batch remap in case the parent inventoryItem was C1-displaced.
      const resolvedIngredientIdForBatchLedger = options?.idRemap?.get(String(payload.ingredientId)) ?? String(payload.ingredientId)

      await db.inventoryBatchUsageLedger.upsert({
        where: { id: String(payload.id || change.entityId) },
        update: {
          restaurantId: batchUsageRestaurantId,
          branchId: batchUsageBranchId,
          purchaseId: payload.purchaseId,
          ingredientId: resolvedIngredientIdForBatchLedger,
          sourceType: payload.sourceType,
          sourceId: payload.sourceId,
          batchId: payload.batchId,
          quantityConsumed: Number(payload.quantityConsumed),
          unitCost: Number(payload.unitCost),
          totalCost: Number(payload.totalCost),
          reason: payload.reason ?? null,
          consumedAt: asDate(payload.consumedAt) ?? new Date(),
          createdAt: asDate(payload.createdAt) ?? undefined,
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
        create: {
          id: String(payload.id || change.entityId),
          restaurantId: batchUsageRestaurantId,
          branchId: batchUsageBranchId,
          purchaseId: payload.purchaseId,
          ingredientId: resolvedIngredientIdForBatchLedger,
          sourceType: payload.sourceType,
          sourceId: payload.sourceId,
          batchId: payload.batchId,
          quantityConsumed: Number(payload.quantityConsumed),
          unitCost: Number(payload.unitCost),
          totalCost: Number(payload.totalCost),
          reason: payload.reason ?? null,
          consumedAt: asDate(payload.consumedAt) ?? new Date(),
          createdAt: asDate(payload.createdAt) ?? new Date(),
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
      })
      break
    }
    case 'wasteLog': {
      if (change.operation === 'delete') {
        await db.wasteLog.deleteMany({ where: { id: change.entityId } })
        break
      }

      const wasteRestaurantId = String(payload.restaurantId ?? '').trim()
      const wasteBranchId = await resolveSyncBranchId(
        db, payload.branchId, wasteRestaurantId, 'wasteLog', change.entityId,
      )
      // C-branchskip: throw so applyIncomingSyncChanges records to failedChanges.
      if (!wasteBranchId) throw new Error(`[syncEngine] wasteLog:${change.entityId} — no resolvable branchId; restaurant has no active branches`)

      // Resolve ingredientId via batch remap in case the parent inventoryItem was C1-displaced.
      const resolvedIngredientIdForWaste = options?.idRemap?.get(String(payload.ingredientId)) ?? String(payload.ingredientId)

      await db.wasteLog.upsert({
        where: { id: String(payload.id || change.entityId) },
        update: {
          restaurantId: wasteRestaurantId,
          branchId: wasteBranchId,
          ingredientId: resolvedIngredientIdForWaste,
          quantityWasted: Number(payload.quantityWasted),
          reason: payload.reason,
          date: asDate(payload.date) ?? new Date(),
          calculatedCost: Number(payload.calculatedCost ?? 0),
          notes: payload.notes ?? null,
          createdAt: asDate(payload.createdAt) ?? undefined,
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
        create: {
          id: String(payload.id || change.entityId),
          restaurantId: wasteRestaurantId,
          branchId: wasteBranchId,
          ingredientId: resolvedIngredientIdForWaste,
          quantityWasted: Number(payload.quantityWasted),
          reason: payload.reason,
          date: asDate(payload.date) ?? new Date(),
          calculatedCost: Number(payload.calculatedCost ?? 0),
          notes: payload.notes ?? null,
          createdAt: asDate(payload.createdAt) ?? new Date(),
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
      })
      break
    }
    case 'shift':
    case 'employeeShift': {
      if (change.operation === 'delete') {
        await db.employeeShift.deleteMany({ where: { id: change.entityId } })
        break
      }

      const shiftRestaurantId = String(payload.restaurantId ?? '').trim()
      const shiftBranchId = await resolveSyncBranchId(
        db, payload.branchId, shiftRestaurantId, 'employeeShift', change.entityId,
      )
      if (!shiftBranchId) throw new Error(`[syncEngine] employeeShift:${change.entityId} — no resolvable branchId; restaurant has no active branches`)

      const shiftStaffId = String(payload.staffId || payload.employeeId || '')
      const clockInAt = asDate(payload.clockInAt ?? payload.date) ?? new Date()
      const durationMins = payload.durationMins != null
        ? Number(payload.durationMins)
        : payload.hoursWorked != null ? Math.round(Number(payload.hoursWorked) * 60) : null

      await db.employeeShift.upsert({
        where: { id: String(payload.id || change.entityId) },
        update: {
          restaurantId: shiftRestaurantId,
          branchId: shiftBranchId,
          staffId: shiftStaffId,
          clockInAt,
          durationMins,
          notes: payload.notes ?? null,
          createdAt: asDate(payload.createdAt) ?? undefined,
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
        create: {
          id: String(payload.id || change.entityId),
          restaurantId: shiftRestaurantId,
          branchId: shiftBranchId,
          staffId: shiftStaffId,
          clockInAt,
          durationMins,
          notes: payload.notes ?? null,
          createdAt: asDate(payload.createdAt) ?? new Date(),
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
      })
      break
    }
    case 'dishSale': {
      if (change.operation === 'delete') {
        await db.dishSale.deleteMany({ where: { id: change.entityId } })
        break
      }

      const dishSaleRestaurantId = String(payload.restaurantId ?? '').trim()
      const dishSaleBranchId = await resolveSyncBranchId(
        db, payload.branchId, dishSaleRestaurantId, 'dishSale', change.entityId,
      )
      // C-branchskip: throw so applyIncomingSyncChanges records to failedChanges.
      if (!dishSaleBranchId) throw new Error(`[syncEngine] dishSale:${change.entityId} — no resolvable branchId; restaurant has no active branches`)

      // Resolve dishId via batch remap in case the parent dish was C1-displaced.
      const resolvedDishIdForSale = options?.idRemap?.get(String(payload.dishId)) ?? String(payload.dishId)

      await db.dishSale.upsert({
        where: { id: String(payload.id || change.entityId) },
        update: {
          restaurantId: dishSaleRestaurantId,
          branchId: dishSaleBranchId,
          orderId: payload.orderId ?? null,
          dishId: resolvedDishIdForSale,
          dishName: String(payload.dishName ?? ''),
          quantitySold: Number(payload.quantitySold),
          saleDate: asDate(payload.saleDate) ?? new Date(),
          paymentMethod: payload.paymentMethod ?? 'Cash',
          totalSaleAmount: Number(payload.totalSaleAmount),
          calculatedFoodCost: Number(payload.calculatedFoodCost ?? 0),
          createdAt: asDate(payload.createdAt) ?? undefined,
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
        create: {
          id: String(payload.id || change.entityId),
          restaurantId: dishSaleRestaurantId,
          branchId: dishSaleBranchId,
          orderId: payload.orderId ?? null,
          dishId: resolvedDishIdForSale,
          dishName: String(payload.dishName ?? ''),
          quantitySold: Number(payload.quantitySold),
          saleDate: asDate(payload.saleDate) ?? new Date(),
          paymentMethod: payload.paymentMethod ?? 'Cash',
          totalSaleAmount: Number(payload.totalSaleAmount),
          calculatedFoodCost: Number(payload.calculatedFoodCost ?? 0),
          createdAt: asDate(payload.createdAt) ?? new Date(),
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
      })

      if (Array.isArray(payload.saleIngredients)) {
        await db.dishSaleIngredient.deleteMany({ where: { dishSaleId: String(payload.id || change.entityId) } })
        if (payload.saleIngredients.length > 0) {
          await db.dishSaleIngredient.createMany({
            data: payload.saleIngredients.map((row: any) => ({
              id: row.id,
              dishSaleId: String(payload.id || change.entityId),
              // Resolve ingredientId via batch remap in case parent inventoryItem was C1-displaced.
              ingredientId: options?.idRemap?.get(String(row.ingredientId)) ?? String(row.ingredientId),
              quantityUsed: Number(row.quantityUsed),
              actualCost: Number(row.actualCost),
            })),
          })
        }
      }
      break
    }
    case 'restaurantOrder': {
      if (change.operation === 'delete') {
        await db.restaurantOrder.deleteMany({ where: { id: change.entityId } })
        break
      }

      const orderRestaurantId = String(payload.restaurantId ?? '').trim()
      const orderBranchId = await resolveSyncBranchId(
        db, payload.branchId, orderRestaurantId, 'restaurantOrder', change.entityId,
      )
      // C-branchskip: throw so applyIncomingSyncChanges records to failedChanges.
      if (!orderBranchId) throw new Error(`[syncEngine] restaurantOrder:${change.entityId} — no resolvable branchId; restaurant has no active branches`)

      await db.restaurantOrder.upsert({
        where: { id: String(payload.id || change.entityId) },
        update: {
          restaurantId: orderRestaurantId,
          branchId: orderBranchId,
          tableName: payload.tableName,
          orderNumber: payload.orderNumber,
          status: payload.status ?? 'OPEN',
          paymentMethod: payload.paymentMethod ?? null,
          subtotalAmount: Number(payload.subtotalAmount ?? 0),
          vatAmount: Number(payload.vatAmount ?? 0),
          totalAmount: Number(payload.totalAmount ?? 0),
          staffId: payload.staffId ?? null,
          createdByName: payload.createdByName ?? null,
          cancelReason: payload.cancelReason ?? null,
          paidAt: asDate(payload.paidAt),
          canceledAt: asDate(payload.canceledAt),
          createdAt: asDate(payload.createdAt) ?? undefined,
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
        create: {
          id: String(payload.id || change.entityId),
          restaurantId: orderRestaurantId,
          branchId: orderBranchId,
          tableId: null,
          tableName: payload.tableName,
          orderNumber: payload.orderNumber,
          status: payload.status ?? 'OPEN',
          paymentMethod: payload.paymentMethod ?? null,
          subtotalAmount: Number(payload.subtotalAmount ?? 0),
          vatAmount: Number(payload.vatAmount ?? 0),
          totalAmount: Number(payload.totalAmount ?? 0),
          staffId: payload.staffId ?? null,
          createdByName: payload.createdByName ?? null,
          cancelReason: payload.cancelReason ?? null,
          paidAt: asDate(payload.paidAt),
          canceledAt: asDate(payload.canceledAt),
          createdAt: asDate(payload.createdAt) ?? new Date(),
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
      })

      // Sync embedded order items — delete existing then recreate from payload.
      // This is safe: the parent order upsert above runs first (same tx on cloud side),
      // so FK constraint on RestaurantOrderItem.orderId is already satisfied.
      if (Array.isArray(payload.items) && payload.items.length > 0) {
        const orderId = String(payload.id || change.entityId)
        // M3: Validate all item ids BEFORE deleteMany. If any item is missing an id,
        // createMany would throw a unique-constraint error after deleteMany has already run,
        // leaving the order on cloud with 0 items — corrupts FIFO cost and revenue reports.
        const validItems = payload.items.filter((item: any) => Boolean(item.id))
        if (validItems.length < payload.items.length) {
          console.warn(
            '[syncEngine] restaurantOrder %s: %d of %d items missing id — those items will not be synced',
            orderId,
            payload.items.length - validItems.length,
            payload.items.length,
          )
        }
        if (validItems.length > 0) {
          await db.orderItem.deleteMany({ where: { orderId } })
          await db.orderItem.createMany({
            data: validItems.map((item: any) => ({
              id: String(item.id),
              orderId,
              dishId: String(item.dishId),
              dishName: String(item.dishName ?? ''),
              dishPrice: Number(item.dishPrice ?? 0),
              totalPrice: Number(item.totalPrice ?? item.dishPrice ?? 0),
              qty: Number(item.qty ?? 1),
              kitchenStatus: String(item.kitchenStatus ?? 'new'),
              status: String(item.status ?? 'ACTIVE'),
              cancelReason: item.cancelReason ?? null,
              notes: item.notes ?? null,
              readyAt: asDate(item.readyAt),
              canceledAt: asDate(item.canceledAt),
              createdAt: asDate(item.createdAt) ?? new Date(),
              updatedAt: asDate(item.updatedAt) ?? new Date(),
            })),
          })
        }
      } else if (Array.isArray(payload.items) && payload.items.length === 0 && payload.status !== 'CANCELED') {
        // Guard: warn if order arrived with 0 items and is not canceled — likely a serialization issue
        console.warn(`[syncEngine] restaurantOrder ${String(payload.id || change.entityId)} arrived with 0 items (status=${payload.status})`)
      }

      break
    }
    default:
      // M1: Throw instead of silently breaking. Unknown entity types were previously
      // counted as applied and recorded for pull even though nothing was written.
      // Now the error propagates to applyIncomingSyncChanges' try/catch → failedChanges.
      throw new Error(`[syncEngine] Unhandled entityType '${change.entityType}' (entityId: ${change.entityId}) — change was not applied`)
  }
}

export async function applyIncomingSyncChanges(
  db: PrismaDb,
  changes: SyncChangeEnvelope[],
  options: { localDeviceId?: string; remapUserId?: string } = {},
) {
  const localDeviceId = options.localDeviceId || getSyncDeviceId()
  let applied = 0
  let conflicts = 0
  const appliedChanges: SyncChangeEnvelope[] = []

  const failedChanges: Array<{ change: SyncChangeEnvelope; error: string }> = []
  // Shared remap table for C1 id-displacement within this batch.
  // FK-dependent entities (inventoryPurchase, dishIngredient, etc.) resolve parent ids through it.
  const idRemap = new Map<string, string>()

  for (const change of changes) {
    const pendingConflict = await hasPendingLocalConflict(db, change, localDeviceId)
    if (pendingConflict) {
      conflicts += 1
      await logSyncConflict(db, {
        scopeId: change.scopeId,
        restaurantId: change.restaurantId,
        branchId: change.branchId,
        entityType: change.entityType,
        entityId: change.entityId,
        reason: 'Pending local outbox change exists for this entity',
        localMutationId: pendingConflict.mutationId,
        remoteMutationId: change.mutationId,
        localPayload: {
          operation: pendingConflict.operation,
          payload: JSON.parse(pendingConflict.payload),
        },
        remotePayload: {
          operation: change.operation,
          payload: change.payload,
        },
      })
      continue
    }

    // C2: Isolate per-entity failures — one bad row must not abort the entire batch.
    try {
      await applyResolvedSyncChange(db, change, { remapUserId: options.remapUserId, idRemap })
      applied += 1
      appliedChanges.push(change)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(
        '[syncEngine] Failed to apply %s:%s — %s',
        change.entityType, change.entityId, message,
      )
      failedChanges.push({ change, error: message })
    }
  }

  return { applied, conflicts, failedChanges, appliedChanges }
}

export async function recordRemoteChangeForPull(db: PrismaDb, change: SyncChangeEnvelope): Promise<SyncOutbox> {
  return db.syncOutbox.upsert({
    where: {
      scopeId_mutationId: {
        scopeId: change.scopeId,
        mutationId: change.mutationId,
      },
    },
    create: {
      scopeId: change.scopeId,
      restaurantId: change.restaurantId ?? null,
      branchId: isRestaurantWideSyncEntity(change.entityType) ? null : (change.branchId ?? null),
      entityType: change.entityType,
      entityId: change.entityId,
      operation: change.operation,
      payload: serializeOutboxPayload(change.payload),
      mutationId: change.mutationId,
      sourceDeviceId: change.sourceDeviceId,
      availableAt: new Date(change.createdAt),
    },
    update: {
      operation: change.operation,
      payload: serializeOutboxPayload(change.payload),
      branchId: isRestaurantWideSyncEntity(change.entityType) ? null : (change.branchId ?? null),
      sourceDeviceId: change.sourceDeviceId,
      availableAt: new Date(change.createdAt),
    },
  })
}