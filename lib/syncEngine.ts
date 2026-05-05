import type { Prisma, PrismaClient, SyncOutbox } from '@prisma/client'

import { ensureAccount, ensureCoreCategories } from '@/lib/accounting'
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

function resolveSyncedAccountType(categoryType: string) {
  if (categoryType === 'income') return 'revenue'
  if (categoryType === 'expense') return 'expense'
  return categoryType
}

function inferSyncedTransactionCategoryType(payload: Record<string, any>) {
  const explicit = String(payload.categoryType ?? '').trim().toLowerCase()
  if (explicit) return explicit

  const sourceKind = String(payload.sourceKind ?? '').trim().toLowerCase()
  if (sourceKind === 'dish_sale_mirror') return 'income'

  const accountName = String(payload.accountName ?? '').trim().toLowerCase()
  if (accountName.includes('payable')) return 'liability'
  if (accountName.includes('receivable')) return 'asset'
  if (accountName.includes('cash') || accountName.includes('bank') || accountName.includes('momo') || accountName.includes('mobile money')) {
    return 'asset'
  }

  return payload.type === 'credit' ? 'income' : 'expense'
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
    await (db as PrismaClient).restaurantBranch.findFirst({
      where: { restaurantId: resId, isMain: true, isActive: true },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    }) ??
    await (db as PrismaClient).restaurantBranch.findFirst({
      where: { restaurantId: resId, isActive: true },
      select: { id: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
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

export async function applyResolvedSyncChange(db: PrismaDb, change: SyncChangeEnvelope, options?: { remapUserId?: string }) {
  const payload = (change.payload ?? {}) as Record<string, any>

  // When syncing to cloud, local user IDs don't exist in the cloud users table.
  // Remap ownerId/userId to the authenticated cloud user if provided.
  const ownerId = options?.remapUserId ?? payload.ownerId
  const userId = options?.remapUserId ?? payload.userId

  switch (change.entityType) {
    case 'restaurant': {
      await db.restaurant.upsert({
        where: { id: String(payload.id || change.entityId) },
        update: {
          name: payload.name,
          ownerId: ownerId,
          joinCode: payload.joinCode,
          syncRestaurantId: payload.syncRestaurantId ?? null,
          syncToken: payload.syncToken ?? null,
          billHeader: payload.billHeader ?? '',
          qrOrderingMode: payload.qrOrderingMode ?? 'order',
          fifoEnabled: payload.fifoEnabled == null ? false : Boolean(payload.fifoEnabled),
          fifoConfiguredAt: asDate(payload.fifoConfiguredAt),
          fifoCutoverAt: asDate(payload.fifoCutoverAt),
          trialStartAt: asDate(payload.trialStartAt) ?? new Date(),
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
          syncRestaurantId: payload.syncRestaurantId ?? null,
          syncToken: payload.syncToken ?? null,
          billHeader: payload.billHeader ?? '',
          qrOrderingMode: payload.qrOrderingMode ?? 'order',
          fifoEnabled: payload.fifoEnabled == null ? false : Boolean(payload.fifoEnabled),
          fifoConfiguredAt: asDate(payload.fifoConfiguredAt),
          fifoCutoverAt: asDate(payload.fifoCutoverAt),
          trialStartAt: asDate(payload.trialStartAt) ?? new Date(),
          licenseExpiry: asDate(payload.licenseExpiry),
          licenseActive: payload.licenseActive == null ? true : Boolean(payload.licenseActive),
          createdAt: asDate(payload.createdAt) ?? new Date(),
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
      })
      break
    }
    case 'restaurantBranch': {
      if (change.operation === 'delete') {
        await db.restaurantBranch.deleteMany({ where: { id: change.entityId } })
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
            await db.restaurantBranch.deleteMany({
              where: {
                id: { not: incomingId },
                restaurantId: incomingRestaurantId,
                OR: conflictFilter,
              },
            })
          }
        }
      }

      await db.restaurantBranch.upsert({
        where: { id: String(payload.id || change.entityId) },
        update: {
          restaurantId: payload.restaurantId,
          name: payload.name,
          code: payload.code,
          isMain: Boolean(payload.isMain),
          isActive: payload.isActive == null ? true : Boolean(payload.isActive),
          sortOrder: Number(payload.sortOrder ?? 0),
          createdAt: asDate(payload.createdAt) ?? undefined,
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
        create: {
          id: String(payload.id || change.entityId),
          restaurantId: payload.restaurantId,
          name: payload.name,
          code: payload.code,
          isMain: Boolean(payload.isMain),
          isActive: payload.isActive == null ? true : Boolean(payload.isActive),
          sortOrder: Number(payload.sortOrder ?? 0),
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
      if (!tableBranchId) break  // restaurant has no branches — skip, already logged

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
      if (change.operation === 'delete') {
        await db.pricingPlan.deleteMany({ where: { id: change.entityId } })
        break
      }

      await db.pricingPlan.upsert({
        where: { id: String(payload.id || change.entityId) },
        update: {
          name: payload.name,
          duration: Number(payload.duration),
          price: Number(payload.price),
          currency: payload.currency ?? 'RWF',
          isActive: Boolean(payload.isActive),
          seedKey: payload.seedKey ?? null,
          systemManaged: Boolean(payload.systemManaged),
          createdAt: asDate(payload.createdAt) ?? undefined,
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
        create: {
          id: String(payload.id || change.entityId),
          name: payload.name,
          duration: Number(payload.duration),
          price: Number(payload.price),
          currency: payload.currency ?? 'RWF',
          isActive: payload.isActive == null ? true : Boolean(payload.isActive),
          seedKey: payload.seedKey ?? null,
          systemManaged: Boolean(payload.systemManaged),
          createdAt: asDate(payload.createdAt) ?? new Date(),
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
      })
      break
    }
    case 'dish': {
      if (change.operation === 'delete') {
        await db.dish.deleteMany({ where: { id: change.entityId } })
        break
      }

      // Reject null branchId — dishes without a branch are invisible to the
      // waiter pull query.  Resolve to the restaurant's main branch instead of
      // silently persisting bad data.  Log any resolution so it is auditable.
      const dishBranchId = await resolveSyncBranchId(
        db, payload.branchId, payload.restaurantId, 'dish', change.entityId,
      )
      if (!dishBranchId) break  // restaurant has no branches — skip, already logged

      await db.dish.upsert({
        where: { id: String(payload.id || change.entityId) },
        update: {
          userId: userId,
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
          id: String(payload.id || change.entityId),
          userId: userId,
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
        await db.dishIngredient.deleteMany({
          where: {
            dishId: String(payload.dishId),
            ingredientId: String(payload.ingredientId),
          },
        })
        break
      }

      await db.dishIngredient.upsert({
        where: {
          dishId_ingredientId: {
            dishId: String(payload.dishId),
            ingredientId: String(payload.ingredientId),
          },
        },
        update: { quantityRequired: Number(payload.quantityRequired) },
        create: {
          dishId: String(payload.dishId),
          ingredientId: String(payload.ingredientId),
          quantityRequired: Number(payload.quantityRequired),
        },
      })
      break
    }
    case 'employee': {
      if (change.operation === 'delete') {
        await db.employee.deleteMany({ where: { id: change.entityId } })
        break
      }

      await db.employee.upsert({
        where: { id: String(payload.id || change.entityId) },
        update: {
          userId: userId,
          restaurantId: payload.restaurantId ?? null,
          branchId: payload.branchId ?? null,
          name: payload.name,
          role: payload.role,
          payType: payload.payType,
          payRate: Number(payload.payRate),
          isActive: payload.isActive == null ? true : Boolean(payload.isActive),
          canApproveOrderCancellation: Boolean(payload.canApproveOrderCancellation),
          cancellationPinHash: payload.cancellationPinHash ?? null,
          phone: payload.phone ?? null,
          createdAt: asDate(payload.createdAt) ?? undefined,
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
        create: {
          id: String(payload.id || change.entityId),
          userId: userId,
          restaurantId: payload.restaurantId ?? null,
          branchId: payload.branchId ?? null,
          name: payload.name,
          role: payload.role,
          payType: payload.payType,
          payRate: Number(payload.payRate),
          isActive: payload.isActive == null ? true : Boolean(payload.isActive),
          canApproveOrderCancellation: Boolean(payload.canApproveOrderCancellation),
          cancellationPinHash: payload.cancellationPinHash ?? null,
          phone: payload.phone ?? null,
          createdAt: asDate(payload.createdAt) ?? new Date(),
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
      })
      break
    }
    case 'transaction': {
      if (change.operation === 'delete') {
        await db.transaction.deleteMany({ where: { id: change.entityId } })
        break
      }

      const transactionRestaurantId = payload.restaurantId ?? null
      const categoryType = inferSyncedTransactionCategoryType(payload)
      const categories = await ensureCoreCategories(db, transactionRestaurantId)
      const category = categories[categoryType] || categories.expense
      const accountName = String(payload.accountName || 'General Expense')
      const account = await ensureAccount(db, {
        restaurantId: transactionRestaurantId,
        name: accountName,
        type: resolveSyncedAccountType(category.type),
        categoryId: category.id,
      })

      await db.transaction.upsert({
        where: { id: String(payload.id || change.entityId) },
        update: {
          userId: userId,
          restaurantId: transactionRestaurantId,
          branchId: payload.branchId ?? null,
          uploadId: payload.uploadId ?? null,
          accountId: account.id,
          categoryId: category.id,
          date: asDate(payload.date) ?? new Date(),
          description: String(payload.description ?? 'Synced transaction'),
          amount: Number(payload.amount),
          type: String(payload.type ?? 'credit'),
          isManual: payload.isManual == null ? false : Boolean(payload.isManual),
          paymentMethod: payload.paymentMethod ?? 'Cash',
          pairId: payload.pairId ?? null,
          accountName: account.name,
          profitAmount: payload.profitAmount == null ? null : Number(payload.profitAmount),
          costAmount: payload.costAmount == null ? null : Number(payload.costAmount),
          synced: payload.synced == null ? true : Boolean(payload.synced),
          sourceKind: payload.sourceKind ?? 'manual',
          authoritativeForRevenue: payload.authoritativeForRevenue == null ? false : Boolean(payload.authoritativeForRevenue),
          createdAt: asDate(payload.createdAt) ?? undefined,
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
        create: {
          id: String(payload.id || change.entityId),
          userId: userId,
          restaurantId: transactionRestaurantId,
          branchId: payload.branchId ?? null,
          uploadId: payload.uploadId ?? null,
          accountId: account.id,
          categoryId: category.id,
          date: asDate(payload.date) ?? new Date(),
          description: String(payload.description ?? 'Synced transaction'),
          amount: Number(payload.amount),
          type: String(payload.type ?? 'credit'),
          isManual: payload.isManual == null ? false : Boolean(payload.isManual),
          paymentMethod: payload.paymentMethod ?? 'Cash',
          pairId: payload.pairId ?? null,
          accountName: account.name,
          profitAmount: payload.profitAmount == null ? null : Number(payload.profitAmount),
          costAmount: payload.costAmount == null ? null : Number(payload.costAmount),
          synced: payload.synced == null ? true : Boolean(payload.synced),
          sourceKind: payload.sourceKind ?? 'manual',
          authoritativeForRevenue: payload.authoritativeForRevenue == null ? false : Boolean(payload.authoritativeForRevenue),
          createdAt: asDate(payload.createdAt) ?? new Date(),
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
      })
      break
    }
    case 'inventoryItem': {
      if (change.operation === 'delete') {
        await db.inventoryItem.deleteMany({ where: { id: change.entityId } })
        break
      }

      await db.inventoryItem.upsert({
        where: { id: String(payload.id || change.entityId) },
        update: {
          userId: userId,
          restaurantId: payload.restaurantId ?? null,
          branchId: payload.branchId ?? null,
          name: payload.name,
          description: payload.description ?? null,
          unit: payload.unit,
          purchaseUnit: payload.purchaseUnit ?? null,
          unitsPerPurchaseUnit: payload.unitsPerPurchaseUnit == null ? null : Number(payload.unitsPerPurchaseUnit),
          unitCost: payload.unitCost == null ? null : Number(payload.unitCost),
          unitPrice: payload.unitPrice == null ? null : Number(payload.unitPrice),
          quantity: Number(payload.quantity ?? 0),
          category: payload.category ?? null,
          inventoryType: payload.inventoryType ?? 'resale',
          reorderLevel: Number(payload.reorderLevel ?? 0),
          shelfLifeDays: payload.shelfLifeDays == null ? null : Number(payload.shelfLifeDays),
          lastRestockedAt: asDate(payload.lastRestockedAt),
          createdAt: asDate(payload.createdAt) ?? undefined,
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
        create: {
          id: String(payload.id || change.entityId),
          userId: userId,
          restaurantId: payload.restaurantId ?? null,
          branchId: payload.branchId ?? null,
          name: payload.name,
          description: payload.description ?? null,
          unit: payload.unit,
          purchaseUnit: payload.purchaseUnit ?? null,
          unitsPerPurchaseUnit: payload.unitsPerPurchaseUnit == null ? null : Number(payload.unitsPerPurchaseUnit),
          unitCost: payload.unitCost == null ? null : Number(payload.unitCost),
          unitPrice: payload.unitPrice == null ? null : Number(payload.unitPrice),
          quantity: Number(payload.quantity ?? 0),
          category: payload.category ?? null,
          inventoryType: payload.inventoryType ?? 'resale',
          reorderLevel: Number(payload.reorderLevel ?? 0),
          shelfLifeDays: payload.shelfLifeDays == null ? null : Number(payload.shelfLifeDays),
          lastRestockedAt: asDate(payload.lastRestockedAt),
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

      await db.inventoryPurchase.upsert({
        where: { id: String(payload.id || change.entityId) },
        update: {
          userId: userId,
          restaurantId: payload.restaurantId ?? null,
          branchId: payload.branchId ?? null,
          batchId: payload.batchId ?? null,
          ingredientId: payload.ingredientId,
          supplier: payload.supplier ?? null,
          purchaseQuantity: payload.purchaseQuantity == null ? null : Number(payload.purchaseQuantity),
          purchaseUnit: payload.purchaseUnit ?? null,
          unitsPerPurchaseUnit: payload.unitsPerPurchaseUnit == null ? null : Number(payload.unitsPerPurchaseUnit),
          purchaseUnitCost: payload.purchaseUnitCost == null ? null : Number(payload.purchaseUnitCost),
          quantityPurchased: Number(payload.quantityPurchased),
          remainingQuantity: Number(payload.remainingQuantity),
          unitCost: Number(payload.unitCost),
          totalCost: Number(payload.totalCost),
          purchasedAt: asDate(payload.purchasedAt) ?? new Date(),
          createdAt: asDate(payload.createdAt) ?? undefined,
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
        create: {
          id: String(payload.id || change.entityId),
          userId: userId,
          restaurantId: payload.restaurantId ?? null,
          branchId: payload.branchId ?? null,
          batchId: payload.batchId ?? null,
          ingredientId: payload.ingredientId,
          supplier: payload.supplier ?? null,
          purchaseQuantity: payload.purchaseQuantity == null ? null : Number(payload.purchaseQuantity),
          purchaseUnit: payload.purchaseUnit ?? null,
          unitsPerPurchaseUnit: payload.unitsPerPurchaseUnit == null ? null : Number(payload.unitsPerPurchaseUnit),
          purchaseUnitCost: payload.purchaseUnitCost == null ? null : Number(payload.purchaseUnitCost),
          quantityPurchased: Number(payload.quantityPurchased),
          remainingQuantity: Number(payload.remainingQuantity),
          unitCost: Number(payload.unitCost),
          totalCost: Number(payload.totalCost),
          purchasedAt: asDate(payload.purchasedAt) ?? new Date(),
          createdAt: asDate(payload.createdAt) ?? new Date(),
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
      })
      break
    }
    case 'inventoryAdjustmentLog': {
      if (change.operation === 'delete') {
        await db.inventoryAdjustmentLog.deleteMany({ where: { id: change.entityId } })
        break
      }

      await db.inventoryAdjustmentLog.upsert({
        where: { id: String(payload.id || change.entityId) },
        update: {
          userId: userId,
          restaurantId: payload.restaurantId ?? null,
          branchId: payload.branchId ?? null,
          ingredientId: payload.ingredientId,
          adjustmentType: payload.adjustmentType,
          quantityDelta: Number(payload.quantityDelta),
          itemQuantityBefore: Number(payload.itemQuantityBefore),
          itemQuantityAfter: Number(payload.itemQuantityAfter),
          batchId: payload.batchId ?? null,
          reason: payload.reason ?? null,
          createdAt: asDate(payload.createdAt) ?? undefined,
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
        create: {
          id: String(payload.id || change.entityId),
          userId: userId,
          restaurantId: payload.restaurantId ?? null,
          branchId: payload.branchId ?? null,
          ingredientId: payload.ingredientId,
          adjustmentType: payload.adjustmentType,
          quantityDelta: Number(payload.quantityDelta),
          itemQuantityBefore: Number(payload.itemQuantityBefore),
          itemQuantityAfter: Number(payload.itemQuantityAfter),
          batchId: payload.batchId ?? null,
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

      await db.inventoryBatchUsageLedger.upsert({
        where: { id: String(payload.id || change.entityId) },
        update: {
          userId: userId,
          restaurantId: payload.restaurantId ?? null,
          branchId: payload.branchId ?? null,
          purchaseId: payload.purchaseId,
          ingredientId: payload.ingredientId,
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
          userId: userId,
          restaurantId: payload.restaurantId ?? null,
          branchId: payload.branchId ?? null,
          purchaseId: payload.purchaseId,
          ingredientId: payload.ingredientId,
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

      await db.wasteLog.upsert({
        where: { id: String(payload.id || change.entityId) },
        update: {
          userId: userId,
          restaurantId: payload.restaurantId ?? null,
          branchId: payload.branchId ?? null,
          ingredientId: payload.ingredientId,
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
          userId: userId,
          restaurantId: payload.restaurantId ?? null,
          branchId: payload.branchId ?? null,
          ingredientId: payload.ingredientId,
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
    case 'shift': {
      if (change.operation === 'delete') {
        await db.shift.deleteMany({ where: { id: change.entityId } })
        break
      }

      await db.shift.upsert({
        where: { id: String(payload.id || change.entityId) },
        update: {
          employeeId: payload.employeeId,
          userId: userId,
          restaurantId: payload.restaurantId ?? null,
          branchId: payload.branchId ?? null,
          date: asDate(payload.date) ?? new Date(),
          hoursWorked: Number(payload.hoursWorked),
          calculatedWage: Number(payload.calculatedWage),
          notes: payload.notes ?? null,
          createdAt: asDate(payload.createdAt) ?? undefined,
        },
        create: {
          id: String(payload.id || change.entityId),
          employeeId: payload.employeeId,
          userId: userId,
          restaurantId: payload.restaurantId ?? null,
          branchId: payload.branchId ?? null,
          date: asDate(payload.date) ?? new Date(),
          hoursWorked: Number(payload.hoursWorked),
          calculatedWage: Number(payload.calculatedWage),
          notes: payload.notes ?? null,
          createdAt: asDate(payload.createdAt) ?? new Date(),
        },
      })
      break
    }
    case 'dishSale': {
      if (change.operation === 'delete') {
        await db.dishSale.deleteMany({ where: { id: change.entityId } })
        break
      }

      await db.dishSale.upsert({
        where: { id: String(payload.id || change.entityId) },
        update: {
          userId: userId,
          restaurantId: payload.restaurantId ?? null,
          branchId: payload.branchId ?? null,
          orderId: payload.orderId ?? null,
          dishId: payload.dishId,
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
          userId: userId,
          restaurantId: payload.restaurantId ?? null,
          branchId: payload.branchId ?? null,
          orderId: payload.orderId ?? null,
          dishId: payload.dishId,
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
              ingredientId: row.ingredientId,
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

      await db.restaurantOrder.upsert({
        where: { id: String(payload.id || change.entityId) },
        update: {
          restaurantId: payload.restaurantId,
          branchId: payload.branchId ?? null,
          // tableId intentionally omitted — RestaurantTable may not exist on the cloud
          tableName: payload.tableName,
          orderNumber: payload.orderNumber,
          status: payload.status ?? 'PENDING',
          paymentMethod: payload.paymentMethod ?? null,
          subtotalAmount: Number(payload.subtotalAmount ?? 0),
          vatAmount: Number(payload.vatAmount ?? 0),
          totalAmount: Number(payload.totalAmount ?? 0),
          createdById: userId,
          createdByName: payload.createdByName,
          servedById: payload.servedById ?? null,
          servedByName: payload.servedByName ?? null,
          paidById: payload.paidById ?? null,
          paidByName: payload.paidByName ?? null,
          canceledById: payload.canceledById ?? null,
          canceledByName: payload.canceledByName ?? null,
          cancellationApprovedByEmployeeId: payload.cancellationApprovedByEmployeeId ?? null,
          cancellationApprovedByEmployeeName: payload.cancellationApprovedByEmployeeName ?? null,
          cancellationApprovedAt: asDate(payload.cancellationApprovedAt),
          cancelReason: payload.cancelReason ?? null,
          servedAt: asDate(payload.servedAt),
          paidAt: asDate(payload.paidAt),
          canceledAt: asDate(payload.canceledAt),
          createdAt: asDate(payload.createdAt) ?? undefined,
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
        create: {
          id: String(payload.id || change.entityId),
          restaurantId: payload.restaurantId,
          branchId: payload.branchId ?? null,
          tableId: null,
          tableName: payload.tableName,
          orderNumber: payload.orderNumber,
          status: payload.status ?? 'PENDING',
          paymentMethod: payload.paymentMethod ?? null,
          subtotalAmount: Number(payload.subtotalAmount ?? 0),
          vatAmount: Number(payload.vatAmount ?? 0),
          totalAmount: Number(payload.totalAmount ?? 0),
          createdById: userId,
          createdByName: payload.createdByName,
          servedById: payload.servedById ?? null,
          servedByName: payload.servedByName ?? null,
          paidById: payload.paidById ?? null,
          paidByName: payload.paidByName ?? null,
          canceledById: payload.canceledById ?? null,
          canceledByName: payload.canceledByName ?? null,
          cancellationApprovedByEmployeeId: payload.cancellationApprovedByEmployeeId ?? null,
          cancellationApprovedByEmployeeName: payload.cancellationApprovedByEmployeeName ?? null,
          cancellationApprovedAt: asDate(payload.cancellationApprovedAt),
          cancelReason: payload.cancelReason ?? null,
          servedAt: asDate(payload.servedAt),
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
        await db.restaurantOrderItem.deleteMany({ where: { orderId } })
        await db.restaurantOrderItem.createMany({
          data: payload.items.map((item: any) => ({
            id: String(item.id || ''),
            orderId,
            dishId: String(item.dishId),
            dishName: String(item.dishName ?? ''),
            dishPrice: Number(item.dishPrice ?? 0),
            qty: Number(item.qty ?? 1),
            kitchenStatus: String(item.kitchenStatus ?? 'new'),
            status: String(item.status ?? 'ACTIVE'),
            canceledById: item.canceledById ?? null,
            canceledByName: item.canceledByName ?? null,
            cancellationApprovedByEmployeeId: item.cancellationApprovedByEmployeeId ?? null,
            cancellationApprovedByEmployeeName: item.cancellationApprovedByEmployeeName ?? null,
            cancelReason: item.cancelReason ?? null,
            wastedById: item.wastedById ?? null,
            wastedByName: item.wastedByName ?? null,
            wasteReason: item.wasteReason ?? null,
            wasteAcknowledged: Boolean(item.wasteAcknowledged ?? false),
            readyAt: asDate(item.readyAt),
            canceledAt: asDate(item.canceledAt),
            wastedAt: asDate(item.wastedAt),
            createdAt: asDate(item.createdAt) ?? new Date(),
            updatedAt: asDate(item.updatedAt) ?? new Date(),
          })),
        })
      } else if (Array.isArray(payload.items) && payload.items.length === 0 && payload.status !== 'CANCELED') {
        // Guard: warn if order arrived with 0 items and is not canceled — likely a serialization issue
        console.warn(`[syncEngine] restaurantOrder ${String(payload.id || change.entityId)} arrived with 0 items (status=${payload.status})`)
      }

      break
    }
    default:
      break
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

    await applyResolvedSyncChange(db, change, { remapUserId: options.remapUserId })
    applied += 1
    appliedChanges.push(change)
  }

  return { applied, conflicts, appliedChanges }
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