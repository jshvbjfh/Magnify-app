import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { hasBranchScopedBackupData } from '@/lib/backupUtils'

export const dynamic = 'force-dynamic'

const backupBranchPresentationSelect = {
  id: true,
  name: true,
  code: true,
  isMain: true,
  isActive: true,
  qrMenuHeroImageUrl: true,
} as const

// ── GET: export full data backup as JSON ──────────────────────────────────────
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const userId = session.user.id
  const context = await getRestaurantContextForUser(userId)
  const restaurant = context?.restaurant ?? null
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null

  if (!restaurantId || !branchId) return NextResponse.json({ error: 'No restaurant context' }, { status: 400 })

  const branchPresentation = await prisma.branch.findUnique({
    where: { id: branchId },
    select: backupBranchPresentationSelect,
  })

  const [
    orderItems,
    restaurantOrders,
    dishes,
    dishIngredients,
    dishSales,
    dishSaleIngredients,
    inventoryItems,
    inventoryPurchases,
    inventoryBatchUsageLedgers,
    inventoryAdjustmentLogs,
    wasteLogs,
    staff,
    shifts,
    tables,
  ] = await Promise.all([
    restaurant ? prisma.orderItem.findMany({ where: { order: { restaurantId: restaurant.id, branchId } } }) : Promise.resolve([]),
    restaurant ? prisma.restaurantOrder.findMany({ where: { restaurantId: restaurant.id, branchId } }) : Promise.resolve([]),
    prisma.dish.findMany({
      where: { restaurantId, branchId },
      include: {
        variants: {
          where: { deletedAt: null },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        },
      },
    }),
    prisma.dishIngredient.findMany({ where: { dish: { restaurantId, branchId } } }),
    prisma.dishSale.findMany({ where: { restaurantId, branchId } }),
    prisma.dishSaleIngredient.findMany({ where: { dishSale: { restaurantId, branchId } } }),
    prisma.inventoryItem.findMany({ where: { restaurantId, branchId } }),
    prisma.inventoryPurchase.findMany({ where: { restaurantId, branchId } }),
    prisma.inventoryBatchUsageLedger.findMany({ where: { restaurantId, branchId } }),
    prisma.inventoryAdjustmentLog.findMany({ where: { restaurantId, branchId } }),
    prisma.wasteLog.findMany({ where: { restaurantId, branchId } }),
    prisma.staff.findMany({ where: { restaurantId, branches: { some: { branchId } } } }),
    prisma.employeeShift.findMany({ where: { restaurantId, branchId } }),
    restaurant ? prisma.restaurantTable.findMany({ where: { restaurantId: restaurant.id, branchId } }) : Promise.resolve([]),
  ])

  const backup = {
    version: 8,
    exportedAt: new Date().toISOString(),
    restaurant: restaurant
      ? {
          id: restaurant.id,
          name: restaurant.name,
          billHeader: restaurant.billHeader,
          joinCode: restaurant.joinCode,
          licenseExpiry: restaurant.licenseExpiry,
          licenseActive: restaurant.licenseActive,
          createdAt: restaurant.createdAt,
          updatedAt: restaurant.updatedAt,
        }
      : null,
    branch: branchPresentation
      ? {
          id: branchPresentation.id,
          name: branchPresentation.name,
          code: branchPresentation.code,
          isMain: branchPresentation.isMain,
          isActive: branchPresentation.isActive,
          qrMenuHeroImageUrl: branchPresentation.qrMenuHeroImageUrl,
        }
      : null,
    tables,
    restaurantOrders,
    restaurantOrderItems: orderItems,
    dishes,
    dishIngredients,
    dishSales,
    dishSaleIngredients,
    inventoryItems,
    inventoryPurchases,
    inventoryBatchUsageLedgers,
    inventoryAdjustmentLogs,
    wasteLogs,
    employees: staff,
    shifts,
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

  const restoreResult = await prisma.$transaction(
    async (tx) => {
      let skippedDishSales = 0
      const restaurant = activeRestaurantId
        ? await tx.restaurant.findUnique({ where: { id: activeRestaurantId } })
        : null
      const restoreBranchId = restaurant
        ? activeBranchId ?? (await tx.branch.findFirst({
            where: { restaurantId: restaurant.id, isMain: true, isActive: true },
            select: { id: true },
          }))?.id ?? null
        : null

      if (restaurant && hasBranchScopedBackupData(backup) && !restoreBranchId) {
        throw new Error('Active station is required to restore station-scoped restaurant data.')
      }

      // ── Restaurant settings ──
      if (backup.restaurant && restaurant) {
        await tx.restaurant.update({
          where: { id: restaurant.id },
          data: {
            name: backup.restaurant.name ?? restaurant.name,
            billHeader: backup.restaurant.billHeader ?? restaurant.billHeader,
          },
        })
      }

      if (backup.branch && restaurant && restoreBranchId) {
        await tx.branch.update({
          where: { id: restoreBranchId },
          data: {
            name: backup.branch.name ?? undefined,
            code: backup.branch.code ?? undefined,
            isMain: typeof backup.branch.isMain === 'boolean' ? backup.branch.isMain : undefined,
            isActive: typeof backup.branch.isActive === 'boolean' ? backup.branch.isActive : undefined,
            qrMenuHeroImageUrl: backup.branch.qrMenuHeroImageUrl ?? undefined,
          },
        })
      }

      // ── Tables ──
      if (restaurant) {
        for (const table of (backup.tables ?? [])) {
          await tx.restaurantTable.upsert({
            where: { id: table.id },
            update: { branchId: restoreBranchId!, name: table.name, seats: table.seats, status: table.status },
            create: {
              id: table.id,
              restaurantId: restaurant.id,
              branchId: restoreBranchId!,
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
              branchId: restoreBranchId!,
              tableId: order.tableId ?? null,
              tableName: order.tableName,
              orderNumber: order.orderNumber,
              status: order.status,
              paymentMethod: order.paymentMethod ?? null,
              subtotalAmount: order.subtotalAmount ?? 0,
              vatAmount: order.vatAmount ?? 0,
              totalAmount: order.totalAmount ?? 0,
              cancelReason: order.cancelReason ?? null,
              paidAt: order.paidAt ? new Date(order.paidAt) : null,
              canceledAt: order.canceledAt ? new Date(order.canceledAt) : null,
            },
            create: {
              id: order.id,
              restaurantId: restaurant.id,
              branchId: restoreBranchId!,
              ...(order.tableId ? { tableId: order.tableId } : {}),
              tableName: order.tableName,
              orderNumber: order.orderNumber,
              status: order.status ?? 'OPEN',
              paymentMethod: order.paymentMethod ?? null,
              subtotalAmount: order.subtotalAmount ?? 0,
              vatAmount: order.vatAmount ?? 0,
              totalAmount: order.totalAmount ?? 0,
              cancelReason: order.cancelReason ?? null,
              createdAt: new Date(order.createdAt),
              paidAt: order.paidAt ? new Date(order.paidAt) : null,
              canceledAt: order.canceledAt ? new Date(order.canceledAt) : null,
              updatedAt: new Date(order.updatedAt),
            },
          })
        }

        for (const item of (backup.restaurantOrderItems ?? [])) {
          await tx.orderItem.upsert({
            where: { id: item.id },
            update: {
              dishId: item.dishId,
              dishVariantId: item.dishVariantId ?? null,
              dishVariantName: item.dishVariantName ?? null,
              dishName: item.dishName,
              dishPrice: item.dishPrice,
              qty: item.qty,
              kitchenStatus: item.kitchenStatus,
              status: item.status,
              branchId: item.branchId ?? null,
              cancelReason: item.cancelReason ?? null,
              readyAt: item.readyAt ? new Date(item.readyAt) : null,
              canceledAt: item.canceledAt ? new Date(item.canceledAt) : null,
            },
            create: {
              id: item.id,
              orderId: item.orderId,
              dishId: item.dishId,
              dishVariantId: item.dishVariantId ?? null,
              dishVariantName: item.dishVariantName ?? null,
              dishName: item.dishName,
              dishPrice: item.dishPrice,
              qty: item.qty ?? 1,
              kitchenStatus: item.kitchenStatus ?? 'new',
              status: item.status ?? 'ACTIVE',
              branchId: item.branchId ?? null,
              cancelReason: item.cancelReason ?? null,
              readyAt: item.readyAt ? new Date(item.readyAt) : null,
              canceledAt: item.canceledAt ? new Date(item.canceledAt) : null,
              createdAt: new Date(item.createdAt),
              updatedAt: new Date(item.updatedAt),
            },
          })
        }
      }

      // ── Inventory items ──
      if (restaurant && restoreBranchId) {
        const rId = restaurant.id
        const bId = restoreBranchId
        for (const item of (backup.inventoryItems ?? [])) {
          await tx.inventoryItem.upsert({
            where: { id: item.id },
            update: { name: item.name, restaurantId: rId, branchId: bId, unit: item.unit, unitCost: item.unitCost ?? 0, quantity: item.quantity, reorderLevel: item.reorderLevel },
            create: { id: item.id, restaurantId: rId, branchId: bId, name: item.name, description: item.description ?? null, unit: item.unit, unitCost: item.unitCost ?? 0, quantity: item.quantity ?? 0, category: item.category ?? null, reorderLevel: item.reorderLevel ?? 0, createdAt: new Date(item.createdAt), updatedAt: new Date(item.updatedAt) },
          })
        }

        // ── Inventory purchases ──
        for (const purchase of (backup.inventoryPurchases ?? [])) {
          await tx.inventoryPurchase.upsert({
            where: { id: purchase.id },
            update: { restaurantId: rId, branchId: bId, ingredientId: purchase.ingredientId, batchId: purchase.batchId ?? null, quantityPurchased: purchase.quantityPurchased, remainingQuantity: purchase.remainingQuantity, unitCost: purchase.unitCost, totalCost: purchase.totalCost, paymentMethod: purchase.paymentMethod ?? 'Cash', expiresAt: purchase.expiresAt ? new Date(purchase.expiresAt) : null },
            create: { id: purchase.id, restaurantId: rId, branchId: bId, ingredientId: purchase.ingredientId, batchId: purchase.batchId ?? null, supplier: purchase.supplier ?? null, quantityPurchased: purchase.quantityPurchased, remainingQuantity: purchase.remainingQuantity, unitCost: purchase.unitCost, totalCost: purchase.totalCost, paymentMethod: purchase.paymentMethod ?? 'Cash', purchasedAt: new Date(purchase.purchasedAt), createdAt: new Date(purchase.createdAt), expiresAt: purchase.expiresAt ? new Date(purchase.expiresAt) : null },
          })
        }

        // ── Inventory adjustment logs ──
        for (const log of (backup.inventoryAdjustmentLogs ?? [])) {
          await tx.inventoryAdjustmentLog.upsert({
            where: { id: log.id },
            update: { restaurantId: rId, branchId: bId, ingredientId: log.ingredientId, adjustmentType: log.adjustmentType, quantityDelta: log.quantityDelta, itemQuantityBefore: log.itemQuantityBefore, itemQuantityAfter: log.itemQuantityAfter, reason: log.reason ?? null, updatedAt: log.updatedAt ? new Date(log.updatedAt) : new Date() },
            create: { id: log.id, restaurantId: rId, branchId: bId, ingredientId: log.ingredientId, adjustmentType: log.adjustmentType, quantityDelta: log.quantityDelta, itemQuantityBefore: log.itemQuantityBefore, itemQuantityAfter: log.itemQuantityAfter, reason: log.reason ?? null, createdAt: log.createdAt ? new Date(log.createdAt) : new Date(), updatedAt: log.updatedAt ? new Date(log.updatedAt) : new Date() },
          })
        }

        // ── Inventory batch usage ledger ──
        for (const usage of (backup.inventoryBatchUsageLedgers ?? [])) {
          await tx.inventoryBatchUsageLedger.upsert({
            where: { id: usage.id },
            update: { restaurantId: rId, branchId: bId, purchaseId: usage.purchaseId, ingredientId: usage.ingredientId, sourceType: usage.sourceType, sourceId: usage.sourceId, batchId: usage.batchId, quantityConsumed: usage.quantityConsumed, unitCost: usage.unitCost, totalCost: usage.totalCost, reason: usage.reason ?? null, consumedAt: usage.consumedAt ? new Date(usage.consumedAt) : new Date(), updatedAt: usage.updatedAt ? new Date(usage.updatedAt) : new Date() },
            create: { id: usage.id, restaurantId: rId, branchId: bId, purchaseId: usage.purchaseId, ingredientId: usage.ingredientId, sourceType: usage.sourceType, sourceId: usage.sourceId, batchId: usage.batchId, quantityConsumed: usage.quantityConsumed, unitCost: usage.unitCost, totalCost: usage.totalCost, reason: usage.reason ?? null, consumedAt: usage.consumedAt ? new Date(usage.consumedAt) : new Date(), createdAt: usage.createdAt ? new Date(usage.createdAt) : new Date(), updatedAt: usage.updatedAt ? new Date(usage.updatedAt) : new Date() },
          })
        }

        // ── Dishes ──
        for (const dish of (backup.dishes ?? [])) {
          await tx.dish.upsert({
            where: { id: dish.id },
            update: { restaurantId: rId, branchId: bId, name: dish.name, sellingPrice: dish.sellingPrice, category: dish.category, menuType: dish.menuType ?? null, isActive: dish.isActive },
            create: { id: dish.id, restaurantId: rId, branchId: bId, name: dish.name, sellingPrice: dish.sellingPrice, category: dish.category ?? null, menuType: dish.menuType ?? null, isActive: dish.isActive ?? true, createdAt: new Date(dish.createdAt), updatedAt: new Date(dish.updatedAt) },
          })

          if (Array.isArray(dish.variants)) {
            await tx.dishVariant.deleteMany({ where: { dishId: dish.id } })
            if (dish.variants.length > 0) {
              await tx.dishVariant.createMany({
                data: dish.variants.map((variant: any, index: number) => ({
                  id: variant.id,
                  dishId: dish.id,
                  name: variant.name,
                  sellingPrice: variant.sellingPrice,
                  sortOrder: variant.sortOrder ?? index,
                  isActive: variant.isActive ?? true,
                  createdAt: variant.createdAt ? new Date(variant.createdAt) : new Date(),
                  updatedAt: variant.updatedAt ? new Date(variant.updatedAt) : new Date(),
                  deletedAt: variant.deletedAt ? new Date(variant.deletedAt) : null,
                })),
              })
            }
          }
        }

        // ── Dish sales ──
        const restoredDishSaleIds = new Set<string>()
        for (const sale of (backup.dishSales ?? [])) {
          if (!sale.orderId) { skippedDishSales += 1; continue }
          await tx.dishSale.upsert({
            where: { id: sale.id },
            update: {
              restaurantId: rId,
              branchId: bId,
              orderId: sale.orderId,
              orderItemId: sale.orderItemId ?? null,
              dishVariantId: sale.dishVariantId ?? null,
              dishVariantName: sale.dishVariantName ?? null,
              dishName: sale.dishName ?? sale.dishId ?? 'Unknown',
              quantitySold: sale.quantitySold,
              totalSaleAmount: sale.totalSaleAmount,
              calculatedFoodCost: sale.calculatedFoodCost,
            },
            create: {
              id: sale.id,
              restaurantId: rId,
              branchId: bId,
              orderId: sale.orderId,
              orderItemId: sale.orderItemId ?? null,
              dishId: sale.dishId,
              dishVariantId: sale.dishVariantId ?? null,
              dishVariantName: sale.dishVariantName ?? null,
              dishName: sale.dishName ?? sale.dishId ?? 'Unknown',
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
            create: { id: dsi.id, dishSaleId: dsi.dishSaleId, ingredientId: dsi.ingredientId, quantityUsed: dsi.quantityUsed, actualCost: dsi.actualCost },
          })
        }

        // ── Waste logs ──
        for (const log of (backup.wasteLogs ?? [])) {
          await tx.wasteLog.upsert({
            where: { id: log.id },
            update: { restaurantId: rId, branchId: bId, quantityWasted: log.quantityWasted, reason: log.reason, notes: log.notes },
            create: { id: log.id, restaurantId: rId, branchId: bId, ingredientId: log.ingredientId, quantityWasted: log.quantityWasted, reason: log.reason, date: new Date(log.date), calculatedCost: log.calculatedCost ?? 0, notes: log.notes ?? null, createdAt: new Date(log.createdAt) },
          })
        }
      }

      // ── Staff (formerly employees) ──
      for (const emp of (backup.employees ?? [])) {
        if (!restaurant) continue
        await tx.staff.upsert({
          where: { id: emp.id },
          update: {
            name: emp.name,
            role: emp.role ?? 'waiter',
            isActive: emp.isActive ?? true,
            phone: emp.phone ?? null,
          },
          create: {
            id: emp.id,
            restaurantId: restaurant.id,
            name: emp.name,
            role: emp.role ?? 'waiter',
            isActive: emp.isActive ?? true,
            phone: emp.phone ?? null,
            createdAt: new Date(emp.createdAt),
            updatedAt: new Date(emp.updatedAt),
          },
        })

        if (restoreBranchId) {
          await (tx as any).staffBranch.upsert({
            where: { staffId_branchId: { staffId: emp.id, branchId: restoreBranchId } },
            update: {},
            create: { staffId: emp.id, branchId: restoreBranchId },
          })
        }
      }

      // ── Shifts (mapped to EmployeeShift) ──
      for (const shift of (backup.shifts ?? [])) {
        if (!restaurant || !restoreBranchId) continue
        const staffId = shift.staffId ?? shift.employeeId
        if (!staffId) continue
        await tx.employeeShift.upsert({
          where: { id: shift.id },
          update: {
            durationMins: shift.durationMins ?? (shift.hoursWorked != null ? Math.round(Number(shift.hoursWorked) * 60) : null),
            notes: shift.notes ?? null,
          },
          create: {
            id: shift.id,
            restaurantId: restaurant.id,
            branchId: restoreBranchId,
            staffId,
            clockInAt: shift.clockInAt ? new Date(shift.clockInAt) : new Date(shift.date ?? shift.createdAt),
            clockOutAt: shift.clockOutAt ? new Date(shift.clockOutAt) : null,
            durationMins: shift.durationMins ?? (shift.hoursWorked != null ? Math.round(Number(shift.hoursWorked) * 60) : null),
            notes: shift.notes ?? null,
            createdAt: new Date(shift.createdAt),
          },
        })
      }

      return { skippedDishSales }
    },
    { timeout: 30000 }
  )

  return NextResponse.json({ success: true, restoredAt: new Date().toISOString(), skippedDishSales: restoreResult.skippedDishSales })
}
