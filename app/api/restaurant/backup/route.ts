import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'

export const dynamic = 'force-dynamic'

// ── GET: export full data backup as JSON ──────────────────────────────────────
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const userId = session.user.id
  const context = await getRestaurantContextForUser(userId)
  const billingUserId = context?.billingUserId ?? userId
  const restaurant = context?.restaurant ?? null
  const restaurantId = context?.restaurantId ?? null
  const branch = context?.branch ?? null
  const branchId = context?.branchId ?? null

  const [
    transactions,
    categories,
    accounts,
    restaurantOrders,
    restaurantOrderItems,
    dishes,
    dishIngredients,
    dishSales,
    dishSaleIngredients,
    inventoryItems,
    inventoryPurchases,
    inventoryBatchUsageLedgers,
    inventoryAdjustmentLogs,
    wasteLogs,
    employees,
    shifts,
    tables,
    dailySummaries,
    goals,
  ] = await Promise.all([
    prisma.transaction.findMany({ where: { userId: billingUserId, ...(restaurantId ? { restaurantId } : {}), ...(branchId ? { branchId } : {}) } }),
    prisma.category.findMany(),
    prisma.account.findMany(),
    restaurant ? prisma.restaurantOrder.findMany({ where: { restaurantId: restaurant.id, ...(branchId ? { branchId } : {}) } }) : Promise.resolve([]),
    restaurant ? prisma.restaurantOrderItem.findMany({ where: { order: { restaurantId: restaurant.id, ...(branchId ? { branchId } : {}) } } }) : Promise.resolve([]),
    prisma.dish.findMany({ where: { userId: billingUserId, ...(restaurantId ? { restaurantId } : {}), ...(branchId ? { branchId } : {}) } }),
    prisma.dishIngredient.findMany({
      where: { dish: { userId: billingUserId, ...(restaurantId ? { restaurantId } : {}), ...(branchId ? { branchId } : {}) } },
    }),
    prisma.dishSale.findMany({ where: { userId: billingUserId, ...(restaurantId ? { restaurantId } : {}), ...(branchId ? { branchId } : {}) } }),
    prisma.dishSaleIngredient.findMany({
      where: { dishSale: { userId: billingUserId, ...(restaurantId ? { restaurantId } : {}), ...(branchId ? { branchId } : {}) } },
    }),
    prisma.inventoryItem.findMany({ where: { userId: billingUserId, ...(restaurantId ? { restaurantId } : {}), ...(branchId ? { branchId } : {}) } }),
    prisma.inventoryPurchase.findMany({ where: { userId: billingUserId, ...(restaurantId ? { restaurantId } : {}), ...(branchId ? { branchId } : {}) } }),
    prisma.inventoryBatchUsageLedger.findMany({ where: { userId: billingUserId, ...(restaurantId ? { restaurantId } : {}), ...(branchId ? { branchId } : {}) } }),
    prisma.inventoryAdjustmentLog.findMany({ where: { userId: billingUserId, ...(restaurantId ? { restaurantId } : {}), ...(branchId ? { branchId } : {}) } }),
    prisma.wasteLog.findMany({ where: { userId: billingUserId, ...(restaurantId ? { restaurantId } : {}), ...(branchId ? { branchId } : {}) } }),
    prisma.employee.findMany({ where: { userId: billingUserId, ...(restaurantId ? { restaurantId } : {}), ...(branchId ? { branchId } : {}) } }),
    prisma.shift.findMany({ where: { userId: billingUserId, ...(restaurantId ? { restaurantId } : {}), ...(branchId ? { branchId } : {}) } }),
    restaurant ? prisma.restaurantTable.findMany({ where: { restaurantId: restaurant.id, ...(branchId ? { branchId } : {}) } }) : Promise.resolve([]),
    prisma.dailySummary.findMany({ where: { userId: billingUserId, ...(restaurantId ? { restaurantId } : {}), ...(branchId ? { branchId } : {}) } }),
    prisma.goal.findMany({ where: { userId: billingUserId } }),
  ])

  const backup = {
    version: 6,
    exportedAt: new Date().toISOString(),
    restaurant: restaurant
      ? {
          id: restaurant.id,
          name: restaurant.name,
          billHeader: restaurant.billHeader,
          fifoEnabled: restaurant.fifoEnabled,
          fifoConfiguredAt: restaurant.fifoConfiguredAt,
          fifoCutoverAt: restaurant.fifoCutoverAt,
          joinCode: restaurant.joinCode,
          trialStartAt: restaurant.trialStartAt,
          licenseExpiry: restaurant.licenseExpiry,
          licenseActive: restaurant.licenseActive,
          createdAt: restaurant.createdAt,
          updatedAt: restaurant.updatedAt,
        }
      : null,
    branch: branch
      ? {
          id: branch.id,
          name: branch.name,
          code: branch.code,
          isMain: branch.isMain,
          isActive: branch.isActive,
        }
      : null,
    tables,
    categories,
    accounts,
    transactions,
    restaurantOrders,
    restaurantOrderItems,
    dishes,
    dishIngredients,
    dishSales,
    dishSaleIngredients,
    inventoryItems,
    inventoryPurchases,
    inventoryBatchUsageLedgers,
    inventoryAdjustmentLogs,
    wasteLogs,
    employees,
    shifts,
    dailySummaries,
    goals,
  }

  const json = JSON.stringify(backup, null, 2)
  const filename = `magnify-backup-${new Date().toISOString().slice(0, 10)}.json`

  return new Response(json, {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}

// ── POST: restore from a backup JSON ─────────────────────────────────────────
export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const userId = session.user.id
  const context = await getRestaurantContextForUser(userId)
  const billingUserId = context?.billingUserId ?? userId
  const activeRestaurantId = context?.restaurantId ?? null
  const activeBranchId = context?.branchId ?? null

  let backup: any
  try {
    backup = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON file.' }, { status: 400 })
  }

  if (!backup?.version || !backup?.exportedAt) {
    return NextResponse.json({ error: 'This does not look like a valid Magnify backup file.' }, { status: 400 })
  }

  // Restore runs inside a transaction so it's all-or-nothing
  const restoreResult = await prisma.$transaction(
    async (tx) => {
      let skippedDishSales = 0
      const restaurant = activeRestaurantId
        ? await tx.restaurant.findUnique({ where: { id: activeRestaurantId } })
        : null

      // ── Restaurant settings ──
      if (backup.restaurant && restaurant) {
        await tx.restaurant.update({
          where: { id: restaurant.id },
          data: {
            name: backup.restaurant.name ?? restaurant.name,
            billHeader: backup.restaurant.billHeader ?? restaurant.billHeader,
            fifoEnabled: typeof backup.restaurant.fifoEnabled === 'boolean' ? backup.restaurant.fifoEnabled : restaurant.fifoEnabled,
            fifoConfiguredAt: backup.restaurant.fifoConfiguredAt ? new Date(backup.restaurant.fifoConfiguredAt) : restaurant.fifoConfiguredAt,
            fifoCutoverAt: backup.restaurant.fifoCutoverAt ? new Date(backup.restaurant.fifoCutoverAt) : restaurant.fifoCutoverAt,
          },
        })
      }

      // ── Categories ──
      for (const cat of (backup.categories ?? [])) {
        await tx.category.upsert({
          where: { id: cat.id },
          update: { name: cat.name, type: cat.type, description: cat.description },
          create: {
            id: cat.id,
            name: cat.name,
            type: cat.type,
            description: cat.description ?? null,
            createdAt: new Date(cat.createdAt),
            updatedAt: new Date(cat.updatedAt),
          },
        })
      }

      // ── Accounts ──
      for (const acc of (backup.accounts ?? [])) {
        await tx.account.upsert({
          where: { id: acc.id },
          update: { name: acc.name, code: acc.code, type: acc.type, description: acc.description },
          create: {
            id: acc.id,
            code: acc.code,
            name: acc.name,
            categoryId: acc.categoryId,
            type: acc.type,
            description: acc.description ?? null,
            createdAt: new Date(acc.createdAt),
            updatedAt: new Date(acc.updatedAt),
          },
        })
      }

      // ── Transactions ──
      for (const txn of (backup.transactions ?? [])) {
        await tx.transaction.upsert({
          where: { id: txn.id },
          update: {
            description: txn.description,
            amount: txn.amount,
            type: txn.type,
            date: new Date(txn.date),
            paymentMethod: txn.paymentMethod,
            isManual: txn.isManual,
            accountName: txn.accountName,
            profitAmount: txn.profitAmount,
            costAmount: txn.costAmount,
          },
          create: {
            id: txn.id,
            userId: billingUserId,
            ...(restaurant ? { restaurantId: restaurant.id } : {}),
            ...(activeBranchId ? { branchId: activeBranchId } : {}),
            uploadId: null,
            accountId: txn.accountId,
            categoryId: txn.categoryId,
            date: new Date(txn.date),
            description: txn.description,
            amount: txn.amount,
            type: txn.type,
            isManual: txn.isManual ?? true,
            paymentMethod: txn.paymentMethod ?? 'Cash',
            pairId: txn.pairId ?? null,
            accountName: txn.accountName ?? null,
            profitAmount: txn.profitAmount ?? null,
            costAmount: txn.costAmount ?? null,
            synced: false,
            createdAt: new Date(txn.createdAt),
            updatedAt: new Date(txn.updatedAt),
          },
        })
      }

      // ── Tables ──
      if (restaurant) {
        for (const table of (backup.tables ?? [])) {
          await tx.restaurantTable.upsert({
            where: { id: table.id },
            update: { ...(activeBranchId ? { branchId: activeBranchId } : {}), name: table.name, seats: table.seats, status: table.status },
            create: {
              id: table.id,
              restaurantId: restaurant.id,
              ...(activeBranchId ? { branchId: activeBranchId } : {}),
              name: table.name,
              seats: table.seats ?? 4,
              status: table.status ?? 'available',
              createdAt: new Date(table.createdAt),
              updatedAt: new Date(table.updatedAt),
            },
          })
        }
      }

      // ── Restaurant orders ──
      if (restaurant) {
        for (const order of (backup.restaurantOrders ?? [])) {
          await tx.restaurantOrder.upsert({
            where: { id: order.id },
            update: {
              ...(activeBranchId ? { branchId: activeBranchId } : {}),
              tableId: order.tableId ?? null,
              tableName: order.tableName,
              orderNumber: order.orderNumber,
              status: order.status,
              paymentMethod: order.paymentMethod ?? null,
              subtotalAmount: order.subtotalAmount ?? 0,
              vatAmount: order.vatAmount ?? 0,
              totalAmount: order.totalAmount ?? 0,
              createdById: order.createdById,
              createdByName: order.createdByName,
              servedById: order.servedById ?? null,
              servedByName: order.servedByName ?? null,
              paidById: order.paidById ?? null,
              paidByName: order.paidByName ?? null,
              canceledById: order.canceledById ?? null,
              canceledByName: order.canceledByName ?? null,
              cancellationApprovedByEmployeeId: order.cancellationApprovedByEmployeeId ?? null,
              cancellationApprovedByEmployeeName: order.cancellationApprovedByEmployeeName ?? null,
              cancellationApprovedAt: order.cancellationApprovedAt ? new Date(order.cancellationApprovedAt) : null,
              cancelReason: order.cancelReason ?? null,
              servedAt: order.servedAt ? new Date(order.servedAt) : null,
              paidAt: order.paidAt ? new Date(order.paidAt) : null,
              canceledAt: order.canceledAt ? new Date(order.canceledAt) : null,
            },
            create: {
              id: order.id,
              restaurantId: restaurant.id,
              ...(activeBranchId ? { branchId: activeBranchId } : {}),
              tableId: order.tableId ?? null,
              tableName: order.tableName,
              orderNumber: order.orderNumber,
              status: order.status ?? 'PENDING',
              paymentMethod: order.paymentMethod ?? null,
              subtotalAmount: order.subtotalAmount ?? 0,
              vatAmount: order.vatAmount ?? 0,
              totalAmount: order.totalAmount ?? 0,
              createdById: order.createdById,
              createdByName: order.createdByName,
              servedById: order.servedById ?? null,
              servedByName: order.servedByName ?? null,
              paidById: order.paidById ?? null,
              paidByName: order.paidByName ?? null,
              canceledById: order.canceledById ?? null,
              canceledByName: order.canceledByName ?? null,
              cancellationApprovedByEmployeeId: order.cancellationApprovedByEmployeeId ?? null,
              cancellationApprovedByEmployeeName: order.cancellationApprovedByEmployeeName ?? null,
              cancellationApprovedAt: order.cancellationApprovedAt ? new Date(order.cancellationApprovedAt) : null,
              cancelReason: order.cancelReason ?? null,
              createdAt: new Date(order.createdAt),
              servedAt: order.servedAt ? new Date(order.servedAt) : null,
              paidAt: order.paidAt ? new Date(order.paidAt) : null,
              canceledAt: order.canceledAt ? new Date(order.canceledAt) : null,
              updatedAt: new Date(order.updatedAt),
            },
          })
        }

        for (const item of (backup.restaurantOrderItems ?? [])) {
          await tx.restaurantOrderItem.upsert({
            where: { id: item.id },
            update: {
              dishId: item.dishId,
              dishName: item.dishName,
              dishPrice: item.dishPrice,
              qty: item.qty,
              kitchenStatus: item.kitchenStatus,
              status: item.status,
              canceledById: item.canceledById ?? null,
              canceledByName: item.canceledByName ?? null,
              cancellationApprovedByEmployeeId: item.cancellationApprovedByEmployeeId ?? null,
              cancellationApprovedByEmployeeName: item.cancellationApprovedByEmployeeName ?? null,
              cancelReason: item.cancelReason ?? null,
              wastedById: item.wastedById ?? null,
              wastedByName: item.wastedByName ?? null,
              wasteReason: item.wasteReason ?? null,
              wasteAcknowledged: item.wasteAcknowledged ?? false,
              readyAt: item.readyAt ? new Date(item.readyAt) : null,
              canceledAt: item.canceledAt ? new Date(item.canceledAt) : null,
              wastedAt: item.wastedAt ? new Date(item.wastedAt) : null,
            },
            create: {
              id: item.id,
              orderId: item.orderId,
              dishId: item.dishId,
              dishName: item.dishName,
              dishPrice: item.dishPrice,
              qty: item.qty ?? 1,
              kitchenStatus: item.kitchenStatus ?? 'new',
              status: item.status ?? 'ACTIVE',
              canceledById: item.canceledById ?? null,
              canceledByName: item.canceledByName ?? null,
              cancellationApprovedByEmployeeId: item.cancellationApprovedByEmployeeId ?? null,
              cancellationApprovedByEmployeeName: item.cancellationApprovedByEmployeeName ?? null,
              cancelReason: item.cancelReason ?? null,
              wastedById: item.wastedById ?? null,
              wastedByName: item.wastedByName ?? null,
              wasteReason: item.wasteReason ?? null,
              wasteAcknowledged: item.wasteAcknowledged ?? false,
              readyAt: item.readyAt ? new Date(item.readyAt) : null,
              canceledAt: item.canceledAt ? new Date(item.canceledAt) : null,
              wastedAt: item.wastedAt ? new Date(item.wastedAt) : null,
              createdAt: new Date(item.createdAt),
              updatedAt: new Date(item.updatedAt),
            },
          })
        }
      }

      // ── Inventory items ──
      for (const item of (backup.inventoryItems ?? [])) {
        await tx.inventoryItem.upsert({
          where: { id: item.id },
          update: {
            name: item.name,
            ...(restaurant ? { restaurantId: restaurant.id } : {}),
            ...(activeBranchId ? { branchId: activeBranchId } : {}),
            unit: item.unit,
            purchaseUnit: item.purchaseUnit ?? null,
            unitsPerPurchaseUnit: item.unitsPerPurchaseUnit ?? null,
            unitCost: item.unitCost,
            quantity: item.quantity,
            reorderLevel: item.reorderLevel,
            inventoryType: item.inventoryType,
          },
          create: {
            id: item.id,
            userId: billingUserId,
            ...(restaurant ? { restaurantId: restaurant.id } : {}),
            ...(activeBranchId ? { branchId: activeBranchId } : {}),
            name: item.name,
            description: item.description ?? null,
            unit: item.unit,
            purchaseUnit: item.purchaseUnit ?? null,
            unitsPerPurchaseUnit: item.unitsPerPurchaseUnit ?? null,
            unitCost: item.unitCost ?? null,
            unitPrice: item.unitPrice ?? null,
            quantity: item.quantity ?? 0,
            category: item.category ?? null,
            inventoryType: item.inventoryType ?? 'resale',
            reorderLevel: item.reorderLevel ?? 0,
            shelfLifeDays: item.shelfLifeDays ?? null,
            lastRestockedAt: item.lastRestockedAt ? new Date(item.lastRestockedAt) : null,
            createdAt: new Date(item.createdAt),
            updatedAt: new Date(item.updatedAt),
          },
        })
      }

      // ── Inventory purchases ──
      for (const purchase of (backup.inventoryPurchases ?? [])) {
        await tx.inventoryPurchase.upsert({
          where: { id: purchase.id },
          update: {
            ...(restaurant ? { restaurantId: restaurant.id } : {}),
            ...(activeBranchId ? { branchId: activeBranchId } : {}),
            batchId: purchase.batchId ?? null,
            purchaseQuantity: purchase.purchaseQuantity ?? null,
            purchaseUnit: purchase.purchaseUnit ?? null,
            unitsPerPurchaseUnit: purchase.unitsPerPurchaseUnit ?? null,
            purchaseUnitCost: purchase.purchaseUnitCost ?? null,
            quantityPurchased: purchase.quantityPurchased,
            remainingQuantity: purchase.remainingQuantity,
            unitCost: purchase.unitCost,
            totalCost: purchase.totalCost,
          },
          create: {
            id: purchase.id,
            userId: billingUserId,
            ...(restaurant ? { restaurantId: restaurant.id } : {}),
            ...(activeBranchId ? { branchId: activeBranchId } : {}),
            batchId: purchase.batchId ?? null,
            ingredientId: purchase.ingredientId,
            supplier: purchase.supplier ?? null,
            purchaseQuantity: purchase.purchaseQuantity ?? null,
            purchaseUnit: purchase.purchaseUnit ?? null,
            unitsPerPurchaseUnit: purchase.unitsPerPurchaseUnit ?? null,
            purchaseUnitCost: purchase.purchaseUnitCost ?? null,
            quantityPurchased: purchase.quantityPurchased,
            remainingQuantity: purchase.remainingQuantity,
            unitCost: purchase.unitCost,
            totalCost: purchase.totalCost,
            purchasedAt: new Date(purchase.purchasedAt),
            createdAt: new Date(purchase.createdAt),
          },
        })
      }

      // ── Inventory adjustment logs ──
      for (const log of (backup.inventoryAdjustmentLogs ?? [])) {
        await tx.inventoryAdjustmentLog.upsert({
          where: { id: log.id },
          update: {
            ...(restaurant ? { restaurantId: restaurant.id } : {}),
            ...(activeBranchId ? { branchId: activeBranchId } : {}),
            ingredientId: log.ingredientId,
            adjustmentType: log.adjustmentType,
            quantityDelta: log.quantityDelta,
            itemQuantityBefore: log.itemQuantityBefore,
            itemQuantityAfter: log.itemQuantityAfter,
            batchId: log.batchId ?? null,
            reason: log.reason ?? null,
            updatedAt: log.updatedAt ? new Date(log.updatedAt) : new Date(),
          },
          create: {
            id: log.id,
            userId: billingUserId,
            ...(restaurant ? { restaurantId: restaurant.id } : {}),
            ...(activeBranchId ? { branchId: activeBranchId } : {}),
            ingredientId: log.ingredientId,
            adjustmentType: log.adjustmentType,
            quantityDelta: log.quantityDelta,
            itemQuantityBefore: log.itemQuantityBefore,
            itemQuantityAfter: log.itemQuantityAfter,
            batchId: log.batchId ?? null,
            reason: log.reason ?? null,
            createdAt: log.createdAt ? new Date(log.createdAt) : new Date(),
            updatedAt: log.updatedAt ? new Date(log.updatedAt) : new Date(),
          },
        })
      }

      // ── Inventory batch usage ledger ──
      for (const usage of (backup.inventoryBatchUsageLedgers ?? [])) {
        await tx.inventoryBatchUsageLedger.upsert({
          where: { id: usage.id },
          update: {
            ...(restaurant ? { restaurantId: restaurant.id } : {}),
            ...(activeBranchId ? { branchId: activeBranchId } : {}),
            purchaseId: usage.purchaseId,
            ingredientId: usage.ingredientId,
            sourceType: usage.sourceType,
            sourceId: usage.sourceId,
            batchId: usage.batchId,
            quantityConsumed: usage.quantityConsumed,
            unitCost: usage.unitCost,
            totalCost: usage.totalCost,
            reason: usage.reason ?? null,
            consumedAt: usage.consumedAt ? new Date(usage.consumedAt) : new Date(),
            updatedAt: usage.updatedAt ? new Date(usage.updatedAt) : new Date(),
          },
          create: {
            id: usage.id,
            userId: billingUserId,
            ...(restaurant ? { restaurantId: restaurant.id } : {}),
            ...(activeBranchId ? { branchId: activeBranchId } : {}),
            purchaseId: usage.purchaseId,
            ingredientId: usage.ingredientId,
            sourceType: usage.sourceType,
            sourceId: usage.sourceId,
            batchId: usage.batchId,
            quantityConsumed: usage.quantityConsumed,
            unitCost: usage.unitCost,
            totalCost: usage.totalCost,
            reason: usage.reason ?? null,
            consumedAt: usage.consumedAt ? new Date(usage.consumedAt) : new Date(),
            createdAt: usage.createdAt ? new Date(usage.createdAt) : new Date(),
            updatedAt: usage.updatedAt ? new Date(usage.updatedAt) : new Date(),
          },
        })
      }

      // ── Dishes ──
      for (const dish of (backup.dishes ?? [])) {
        await tx.dish.upsert({
          where: { id: dish.id },
          update: {
            ...(restaurant ? { restaurantId: restaurant.id } : {}),
            ...(activeBranchId ? { branchId: activeBranchId } : {}),
            name: dish.name,
            sellingPrice: dish.sellingPrice,
            category: dish.category,
            isActive: dish.isActive,
          },
          create: {
            id: dish.id,
            userId: billingUserId,
            ...(restaurant ? { restaurantId: restaurant.id } : {}),
            ...(activeBranchId ? { branchId: activeBranchId } : {}),
            name: dish.name,
            sellingPrice: dish.sellingPrice,
            category: dish.category ?? null,
            isActive: dish.isActive ?? true,
            createdAt: new Date(dish.createdAt),
            updatedAt: new Date(dish.updatedAt),
          },
        })
      }

      // ── Dish ingredients ──
      for (const di of (backup.dishIngredients ?? [])) {
        await tx.dishIngredient.upsert({
          where: { id: di.id },
          update: { quantityRequired: di.quantityRequired },
          create: {
            id: di.id,
            dishId: di.dishId,
            ingredientId: di.ingredientId,
            quantityRequired: di.quantityRequired,
          },
        })
      }

      const restoredDishSaleIds = new Set<string>()

      // ── Dish sales ──
      for (const sale of (backup.dishSales ?? [])) {
        if (!sale.orderId) {
          skippedDishSales += 1
          continue
        }

        await tx.dishSale.upsert({
          where: { id: sale.id },
          update: {
            ...(restaurant ? { restaurantId: restaurant.id } : {}),
            ...(activeBranchId ? { branchId: activeBranchId } : {}),
            orderId: sale.orderId,
            quantitySold: sale.quantitySold,
            totalSaleAmount: sale.totalSaleAmount,
            calculatedFoodCost: sale.calculatedFoodCost,
          },
          create: {
            id: sale.id,
            userId: billingUserId,
            ...(restaurant ? { restaurantId: restaurant.id } : {}),
            ...(activeBranchId ? { branchId: activeBranchId } : {}),
            orderId: sale.orderId,
            dishId: sale.dishId,
            quantitySold: sale.quantitySold,
            saleDate: new Date(sale.saleDate),
            paymentMethod: sale.paymentMethod ?? 'Cash',
            totalSaleAmount: sale.totalSaleAmount,
            calculatedFoodCost: sale.calculatedFoodCost ?? 0,
            createdAt: new Date(sale.createdAt),
          },
        })

        restoredDishSaleIds.add(sale.id)
      }

      // ── Dish sale ingredients ──
      for (const dsi of (backup.dishSaleIngredients ?? [])) {
        if (!restoredDishSaleIds.has(dsi.dishSaleId)) continue

        await tx.dishSaleIngredient.upsert({
          where: { id: dsi.id },
          update: { quantityUsed: dsi.quantityUsed, actualCost: dsi.actualCost },
          create: {
            id: dsi.id,
            dishSaleId: dsi.dishSaleId,
            ingredientId: dsi.ingredientId,
            quantityUsed: dsi.quantityUsed,
            actualCost: dsi.actualCost,
          },
        })
      }

      // ── Waste logs ──
      for (const log of (backup.wasteLogs ?? [])) {
        await tx.wasteLog.upsert({
          where: { id: log.id },
          update: { ...(restaurant ? { restaurantId: restaurant.id } : {}), ...(activeBranchId ? { branchId: activeBranchId } : {}), quantityWasted: log.quantityWasted, reason: log.reason, notes: log.notes },
          create: {
            id: log.id,
            userId: billingUserId,
            ...(restaurant ? { restaurantId: restaurant.id } : {}),
            ...(activeBranchId ? { branchId: activeBranchId } : {}),
            ingredientId: log.ingredientId,
            quantityWasted: log.quantityWasted,
            reason: log.reason,
            date: new Date(log.date),
            calculatedCost: log.calculatedCost ?? 0,
            notes: log.notes ?? null,
            createdAt: new Date(log.createdAt),
          },
        })
      }

      // ── Employees ──
      for (const emp of (backup.employees ?? [])) {
        await tx.employee.upsert({
          where: { id: emp.id },
          update: {
            ...(restaurant ? { restaurantId: restaurant.id } : {}),
            ...(activeBranchId ? { branchId: activeBranchId } : {}),
            name: emp.name,
            role: emp.role,
            payType: emp.payType,
            payRate: emp.payRate,
            isActive: emp.isActive,
            phone: emp.phone,
          },
          create: {
            id: emp.id,
            userId: billingUserId,
            ...(restaurant ? { restaurantId: restaurant.id } : {}),
            ...(activeBranchId ? { branchId: activeBranchId } : {}),
            name: emp.name,
            role: emp.role,
            payType: emp.payType,
            payRate: emp.payRate,
            isActive: emp.isActive ?? true,
            phone: emp.phone ?? null,
            createdAt: new Date(emp.createdAt),
            updatedAt: new Date(emp.updatedAt),
          },
        })
      }

      // ── Shifts ──
      for (const shift of (backup.shifts ?? [])) {
        await tx.shift.upsert({
          where: { id: shift.id },
          update: { ...(restaurant ? { restaurantId: restaurant.id } : {}), ...(activeBranchId ? { branchId: activeBranchId } : {}), hoursWorked: shift.hoursWorked, calculatedWage: shift.calculatedWage, notes: shift.notes },
          create: {
            id: shift.id,
            employeeId: shift.employeeId,
            userId: billingUserId,
            ...(restaurant ? { restaurantId: restaurant.id } : {}),
            ...(activeBranchId ? { branchId: activeBranchId } : {}),
            date: new Date(shift.date),
            hoursWorked: shift.hoursWorked,
            calculatedWage: shift.calculatedWage,
            notes: shift.notes ?? null,
            createdAt: new Date(shift.createdAt),
          },
        })
      }

      // ── Daily summaries ──
      for (const ds of (backup.dailySummaries ?? [])) {
        await tx.dailySummary.upsert({
          where: { id: ds.id },
          update: {
            ...(restaurant ? { restaurantId: restaurant.id } : {}),
            ...(activeBranchId ? { branchId: activeBranchId } : {}),
            totalRevenue: ds.totalRevenue,
            totalExpenses: ds.totalExpenses,
            profitLoss: ds.profitLoss,
          },
          create: {
            id: ds.id,
            userId: billingUserId,
            ...(restaurant ? { restaurantId: restaurant.id } : {}),
            ...(activeBranchId ? { branchId: activeBranchId } : {}),
            date: new Date(ds.date),
            totalRevenue: ds.totalRevenue,
            totalExpenses: ds.totalExpenses,
            profitLoss: ds.profitLoss,
            synced: false,
            createdAt: new Date(ds.createdAt),
          },
        })
      }

      // ── Goals ──
      for (const goal of (backup.goals ?? [])) {
        await tx.goal.upsert({
          where: { id: goal.id },
          update: { targetAmount: goal.targetAmount },
          create: {
            id: goal.id,
            userId: billingUserId,
            type: goal.type,
            period: goal.period,
            targetAmount: goal.targetAmount,
            startDate: new Date(goal.startDate),
            endDate: new Date(goal.endDate),
            createdAt: new Date(goal.createdAt),
            updatedAt: new Date(goal.updatedAt),
          },
        })
      }

      return { skippedDishSales }
    },
    { timeout: 30000 }
  )

  return NextResponse.json({ success: true, restoredAt: new Date().toISOString(), skippedDishSales: restoreResult.skippedDishSales })
}
