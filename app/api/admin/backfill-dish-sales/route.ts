/**
 * POST /api/admin/backfill-dish-sales
 *
 * One-shot backfill: finds all PAID orders that have no DishSale records and
 * records the missing sales + inventory deductions.  Safe to call multiple
 * times — recordDishSalesForPaidOrder has per-dish idempotency guards.
 *
 * Body: { secret: string, restaurantId: string }
 */

import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { recordDishSalesForPaidOrder } from '@/lib/dishSaleRecording'
import { enqueueSyncChange } from '@/lib/syncOutbox'

export const dynamic = 'force-dynamic'

const REPAIR_SOURCE_DEVICE_ID = 'mobile:backfill'

async function getBillingUserId(restaurantId: string, ownerId: string) {
  const dish = await prisma.dish.findFirst({ where: { restaurantId }, select: { userId: true } })
  if (dish?.userId) return dish.userId
  const inv = await prisma.inventoryItem.findFirst({ where: { restaurantId }, select: { userId: true } })
  if (inv?.userId) return inv.userId
  return ownerId
}

export async function POST(req: Request) {
  const { secret, restaurantId } = (await req.json()) as { secret?: string; restaurantId?: string }

  if (!secret || secret !== process.env.BACKFILL_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!restaurantId) {
    return NextResponse.json({ error: 'restaurantId required' }, { status: 400 })
  }

  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { id: true, ownerId: true },
  })
  if (!restaurant) {
    return NextResponse.json({ error: 'Restaurant not found' }, { status: 404 })
  }

  const billingUserId = await getBillingUserId(restaurant.id, restaurant.ownerId)

  // Find PAID orders with zero dish sales
  const paidOrders = await prisma.restaurantOrder.findMany({
    where: { restaurantId, status: 'PAID' },
    include: { items: { where: { status: 'ACTIVE' } } },
  })

  // Get order IDs that already have at least one dish sale
  const orderIdsWithSales = new Set(
    (await prisma.dishSale.findMany({
      where: { restaurantId, orderId: { in: paidOrders.map(o => o.id) } },
      select: { orderId: true },
    })).map(s => s.orderId).filter((id): id is string => id !== null)
  )

  const missing = paidOrders.filter(o => !orderIdsWithSales.has(o.id) && o.items.length > 0)

  const results: { orderId: string; status: 'ok' | 'error'; message?: string }[] = []

  for (const order of missing) {
    try {
      await recordDishSalesForPaidOrder(prisma, {
        billingUserId,
        restaurantId,
        branchId: order.branchId ?? '',
        includeBranchlessRows: false,
        orderId: order.id,
        paymentMethod: order.paymentMethod ?? 'Cash',
        saleDate: order.paidAt ?? order.updatedAt,
        items: order.items.map(item => ({
          dishId: item.dishId,
          dishPrice: Number(item.dishPrice),
          qty: Number(item.qty),
        })),
      })
      results.push({ orderId: order.id, status: 'ok' })
    } catch (err: any) {
      results.push({ orderId: order.id, status: 'error', message: err?.message })
    }
  }

  // Fix existing transactions from mobile-push orders that were created with synced=false
  const fixedTransactions = await prisma.transaction.updateMany({
    where: { restaurantId, synced: false, sourceKind: 'dish_sale_mirror' },
    data: { synced: true },
  })

  const [repairTransactions, repairDishSales, repairInventoryItems, repairInventoryPurchases] = await Promise.all([
    prisma.transaction.findMany({
      where: { restaurantId, sourceKind: 'dish_sale_mirror' },
      include: { category: { select: { type: true } } },
    }),
    prisma.dishSale.findMany({
      where: { restaurantId, userId: billingUserId },
      include: { saleIngredients: true },
    }),
    prisma.inventoryItem.findMany({
      where: { restaurantId, userId: billingUserId },
    }),
    prisma.inventoryPurchase.findMany({
      where: { restaurantId, userId: billingUserId },
    }),
  ])

  for (const transaction of repairTransactions) {
    await enqueueSyncChange(prisma, {
      restaurantId,
      branchId: transaction.branchId ?? null,
      entityType: 'transaction',
      entityId: transaction.id,
      operation: 'upsert',
      sourceDeviceId: REPAIR_SOURCE_DEVICE_ID,
      payload: {
        ...transaction,
        categoryType: transaction.category?.type ?? null,
      },
    })
  }

  for (const sale of repairDishSales) {
    await enqueueSyncChange(prisma, {
      restaurantId,
      branchId: sale.branchId ?? null,
      entityType: 'dishSale',
      entityId: sale.id,
      operation: 'upsert',
      sourceDeviceId: REPAIR_SOURCE_DEVICE_ID,
      payload: {
        ...sale,
        saleIngredients: sale.saleIngredients,
      },
    })
  }

  for (const item of repairInventoryItems) {
    await enqueueSyncChange(prisma, {
      restaurantId,
      branchId: item.branchId ?? null,
      entityType: 'inventoryItem',
      entityId: item.id,
      operation: 'upsert',
      sourceDeviceId: REPAIR_SOURCE_DEVICE_ID,
      payload: item,
    })
  }

  for (const purchase of repairInventoryPurchases) {
    await enqueueSyncChange(prisma, {
      restaurantId,
      branchId: purchase.branchId ?? null,
      entityType: 'inventoryPurchase',
      entityId: purchase.id,
      operation: 'upsert',
      sourceDeviceId: REPAIR_SOURCE_DEVICE_ID,
      payload: purchase,
    })
  }

  return NextResponse.json({
    totalPaid: paidOrders.length,
    missingDishSales: missing.length,
    results,
    fixedTransactions: fixedTransactions.count,
    replayedChanges: {
      transactions: repairTransactions.length,
      dishSales: repairDishSales.length,
      inventoryItems: repairInventoryItems.length,
      inventoryPurchases: repairInventoryPurchases.length,
    },
  })
}
