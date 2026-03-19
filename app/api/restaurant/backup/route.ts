import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

// ── GET: export full data backup as JSON ──────────────────────────────────────
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const userId = session.user.id

  const restaurant = await prisma.restaurant.findFirst({
    where: { ownerId: userId },
    orderBy: { createdAt: 'asc' },
  })
  const restaurantId = restaurant?.id

  const [
    transactions,
    categories,
    accounts,
    dishes,
    dishIngredients,
    dishSales,
    dishSaleIngredients,
    inventoryItems,
    inventoryPurchases,
    wasteLogs,
    employees,
    shifts,
    tables,
    dailySummaries,
    goals,
  ] = await Promise.all([
    prisma.transaction.findMany({ where: { userId } }),
    prisma.category.findMany(),
    prisma.account.findMany(),
    prisma.dish.findMany({ where: { userId } }),
    prisma.dishIngredient.findMany({
      where: { dish: { userId } },
    }),
    prisma.dishSale.findMany({ where: { userId } }),
    prisma.dishSaleIngredient.findMany({
      where: { dishSale: { userId } },
    }),
    prisma.inventoryItem.findMany({ where: { userId } }),
    prisma.inventoryPurchase.findMany({ where: { userId } }),
    prisma.wasteLog.findMany({ where: { userId } }),
    prisma.employee.findMany({ where: { userId } }),
    prisma.shift.findMany({ where: { userId } }),
    restaurant ? prisma.restaurantTable.findMany({ where: { restaurantId: restaurant.id } }) : Promise.resolve([]),
    prisma.dailySummary.findMany({ where: { userId } }),
    prisma.goal.findMany({ where: { userId } }),
  ])

  const backup = {
    version: 2,
    exportedAt: new Date().toISOString(),
    restaurant: restaurant
      ? {
          id: restaurant.id,
          name: restaurant.name,
          billHeader: restaurant.billHeader,
          joinCode: restaurant.joinCode,
          trialStartAt: restaurant.trialStartAt,
          licenseExpiry: restaurant.licenseExpiry,
          licenseActive: restaurant.licenseActive,
          createdAt: restaurant.createdAt,
          updatedAt: restaurant.updatedAt,
        }
      : null,
    tables,
    categories,
    accounts,
    transactions,
    dishes,
    dishIngredients,
    dishSales,
    dishSaleIngredients,
    inventoryItems,
    inventoryPurchases,
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
  await prisma.$transaction(
    async (tx) => {
      const restaurant = await tx.restaurant.findFirst({
        where: { ownerId: userId },
        orderBy: { createdAt: 'asc' },
      })

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
            userId,
            ...(restaurant ? { restaurantId: restaurant.id } : {}),
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
            update: { name: table.name, seats: table.seats, status: table.status },
            create: {
              id: table.id,
              restaurantId: restaurant.id,
              name: table.name,
              seats: table.seats ?? 4,
              status: table.status ?? 'available',
              createdAt: new Date(table.createdAt),
              updatedAt: new Date(table.updatedAt),
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
            unit: item.unit,
            unitCost: item.unitCost,
            quantity: item.quantity,
            reorderLevel: item.reorderLevel,
            inventoryType: item.inventoryType,
          },
          create: {
            id: item.id,
            userId,
            name: item.name,
            description: item.description ?? null,
            unit: item.unit,
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
            quantityPurchased: purchase.quantityPurchased,
            remainingQuantity: purchase.remainingQuantity,
            unitCost: purchase.unitCost,
            totalCost: purchase.totalCost,
          },
          create: {
            id: purchase.id,
            userId,
            ingredientId: purchase.ingredientId,
            supplier: purchase.supplier ?? null,
            quantityPurchased: purchase.quantityPurchased,
            remainingQuantity: purchase.remainingQuantity,
            unitCost: purchase.unitCost,
            totalCost: purchase.totalCost,
            purchasedAt: new Date(purchase.purchasedAt),
            createdAt: new Date(purchase.createdAt),
          },
        })
      }

      // ── Dishes ──
      for (const dish of (backup.dishes ?? [])) {
        await tx.dish.upsert({
          where: { id: dish.id },
          update: {
            name: dish.name,
            sellingPrice: dish.sellingPrice,
            category: dish.category,
            isActive: dish.isActive,
          },
          create: {
            id: dish.id,
            userId,
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

      // ── Dish sales ──
      for (const sale of (backup.dishSales ?? [])) {
        await tx.dishSale.upsert({
          where: { id: sale.id },
          update: {
            quantitySold: sale.quantitySold,
            totalSaleAmount: sale.totalSaleAmount,
            calculatedFoodCost: sale.calculatedFoodCost,
          },
          create: {
            id: sale.id,
            userId,
            dishId: sale.dishId,
            quantitySold: sale.quantitySold,
            saleDate: new Date(sale.saleDate),
            paymentMethod: sale.paymentMethod ?? 'Cash',
            totalSaleAmount: sale.totalSaleAmount,
            calculatedFoodCost: sale.calculatedFoodCost ?? 0,
            createdAt: new Date(sale.createdAt),
          },
        })
      }

      // ── Dish sale ingredients ──
      for (const dsi of (backup.dishSaleIngredients ?? [])) {
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
          update: { quantityWasted: log.quantityWasted, reason: log.reason, notes: log.notes },
          create: {
            id: log.id,
            userId,
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
            name: emp.name,
            role: emp.role,
            payType: emp.payType,
            payRate: emp.payRate,
            isActive: emp.isActive,
            phone: emp.phone,
          },
          create: {
            id: emp.id,
            userId,
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
          update: { hoursWorked: shift.hoursWorked, calculatedWage: shift.calculatedWage, notes: shift.notes },
          create: {
            id: shift.id,
            employeeId: shift.employeeId,
            userId,
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
            totalRevenue: ds.totalRevenue,
            totalExpenses: ds.totalExpenses,
            profitLoss: ds.profitLoss,
          },
          create: {
            id: ds.id,
            userId,
            ...(restaurant ? { restaurantId: restaurant.id } : {}),
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
            userId,
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
    },
    { timeout: 30000 }
  )

  return NextResponse.json({ success: true, restoredAt: new Date().toISOString() })
}
