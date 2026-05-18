import type { Prisma, PrismaClient } from '@prisma/client'

import { recordJournalEntry } from '@/lib/accounting'
import { recordDishSalesForPaidOrder } from '@/lib/dishSaleRecording'
import { calculateRestaurantOrderTotals, enqueueOrderSync, syncRestaurantOrderTotals } from '@/lib/restaurantOrders'
import { enqueueRestaurantTableSync } from '@/lib/restaurantTableSync'

type PrismaDb = PrismaClient | Prisma.TransactionClient

function formatOrderLocation(tableId: string | null | undefined, tableName: string | null | undefined) {
  if (!tableId) return 'Takeaway'
  return tableName?.trim() ? `Table ${tableName.trim()}` : 'Table'
}

function buildDishSaleTransactionDescription(order: {
  items: Array<{ dishId: string; dishName: string; qty: number }>
  tableId: string | null
  tableName: string | null
}) {
  const dishSummary = order.items
    .map((item) => `${item.dishName} [${item.dishId}] x${item.qty}`)
    .join(', ')

  return `DishSale: ${dishSummary} · ${formatOrderLocation(order.tableId, order.tableName)}`
}

export async function finalizeRestaurantOrderPayment(
  db: PrismaDb,
  params: {
    restaurantId: string
    branchId: string
    sourceDeviceId?: string | null
    orderId: string
    paymentMethod?: string | null
    paidAt?: Date
  },
) {
  const currentOrder = await db.restaurantOrder.findFirst({
    where: {
      id: params.orderId,
      restaurantId: params.restaurantId,
      branchId: params.branchId,
    },
    include: { items: { where: { status: 'ACTIVE' } } },
  })

  console.log('[finalize] order lookup', params.orderId, 'status:', currentOrder?.status ?? 'NOT_FOUND', 'items:', currentOrder?.items?.length ?? 0)

  if (!currentOrder) {
    throw new Error('Order not found')
  }

  if (currentOrder.status === 'PAID') {
    // Order is already PAID — backfill any missing dish sales (idempotent per-dish guard).
    console.log('[finalize] order already PAID — backfilling any missing dish sales, items:', currentOrder.items.length)
    if (currentOrder.items.length > 0) {
      await recordDishSalesForPaidOrder(db, {
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        sourceDeviceId: params.sourceDeviceId,
        orderId: params.orderId,
        paymentMethod: params.paymentMethod || currentOrder.paymentMethod || 'Cash',
        saleDate: currentOrder.paidAt ?? params.paidAt ?? new Date(),
        items: currentOrder.items.map((item) => ({
          dishId: item.dishId,
          dishPrice: item.dishPrice,
          qty: item.qty,
        })),
      })
    }
    return currentOrder
  }

  await syncRestaurantOrderTotals(db, params.orderId)

  const paidAt = params.paidAt ?? new Date()
  const normalizedPaymentMethod = params.paymentMethod || currentOrder.paymentMethod || 'Cash'
  const transactionDescription = buildDishSaleTransactionDescription({
    items: currentOrder.items.map((item) => ({
      dishId: item.dishId,
      dishName: item.dishName,
      qty: item.qty,
    })),
    tableId: currentOrder.tableId,
    tableName: currentOrder.tableName,
  })

  const paymentUpdate = await db.restaurantOrder.updateMany({
    where: {
      id: params.orderId,
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      status: 'PENDING',
    },
    data: {
      status: 'PAID',
      paymentMethod: normalizedPaymentMethod,
      paidAt,
      canceledAt: null,
      cancelReason: null,
    },
  })

  if (paymentUpdate.count === 0) {
    return (await db.restaurantOrder.findFirst({
      where: { id: params.orderId, restaurantId: params.restaurantId, branchId: params.branchId },
      include: { items: { where: { status: 'ACTIVE' } } },
    })) ?? currentOrder
  }

  const paidOrder = await db.restaurantOrder.findFirst({
    where: { id: params.orderId, restaurantId: params.restaurantId, branchId: params.branchId },
    include: { items: { where: { status: 'ACTIVE' } } },
  })

  if (!paidOrder) {
    throw new Error('Order not found after payment update')
  }

  await recordDishSalesForPaidOrder(db, {
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    sourceDeviceId: params.sourceDeviceId,
    orderId: params.orderId,
    paymentMethod: normalizedPaymentMethod,
    saleDate: paidAt,
    items: currentOrder.items.map((item) => ({
      dishId: item.dishId,
      dishPrice: item.dishPrice,
      qty: item.qty,
    })),
  })

  const journalAmount = calculateRestaurantOrderTotals(
    currentOrder.items.map((item) => ({ dishPrice: Number(item.dishPrice), qty: Number(item.qty) }))
  ).totalAmount

  await recordJournalEntry(db, {
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    date: paidOrder.paidAt ?? paidAt,
    description: transactionDescription,
    amount: journalAmount,
    direction: 'in',
    accountName: 'DishSale',
    categoryType: 'income',
    paymentMethod: normalizedPaymentMethod,
  })

  if (currentOrder.tableId) {
    await db.restaurantTable.updateMany({
      where: {
        id: currentOrder.tableId,
        restaurantId: params.restaurantId,
        branchId: params.branchId,
      },
      data: { status: 'available' },
    })
    await enqueueRestaurantTableSync(db, currentOrder.tableId, params.restaurantId, params.sourceDeviceId)
  }

  await enqueueOrderSync(db, params.orderId, params.restaurantId, params.branchId, params.sourceDeviceId)

  return paidOrder
}
