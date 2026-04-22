import type { Prisma, PrismaClient, SyncOutbox } from '@prisma/client'

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

      await db.restaurantTable.upsert({
        where: { id: String(payload.id || change.entityId) },
        update: {
          restaurantId: payload.restaurantId,
          branchId: payload.branchId ?? null,
          name: payload.name,
          seats: Number(payload.seats ?? 4),
          status: payload.status ?? 'available',
          createdAt: asDate(payload.createdAt) ?? undefined,
          updatedAt: asDate(payload.updatedAt) ?? new Date(),
        },
        create: {
          id: String(payload.id || change.entityId),
          restaurantId: payload.restaurantId,
          branchId: payload.branchId ?? null,
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

      await db.dish.upsert({
        where: { id: String(payload.id || change.entityId) },
        update: {
          userId: userId,
          restaurantId: payload.restaurantId ?? null,
          branchId: payload.branchId ?? null,
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
          branchId: payload.branchId ?? null,
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
          // Skip quantity on update — derived from purchase layers + consumption, not snapshots
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
          // Skip remainingQuantity on update — managed by FIFO consumption engine
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