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
    billingUserId: string
    restaurantId: string
    branchId: string
    includeBranchlessRows: boolean
    sourceDeviceId?: string | null
    orderId: string
    paidById: string
    paidByName?: string | null
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

  if (!currentOrder) {
    throw new Error('Order not found')
  }

  if (currentOrder.status === 'PAID') {
    return currentOrder
  }

  await syncRestaurantOrderTotals(db, params.orderId)

  const paidAt = params.paidAt ?? new Date()
  const normalizedPaymentMethod = params.paymentMethod || currentOrder.paymentMethod || 'Cash'
  const paymentRecordedByName = currentOrder.createdByName.trim() || params.paidByName?.trim() || 'Staff'
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
      paidById: params.paidById,
      paidByName: paymentRecordedByName,
      canceledAt: null,
      canceledById: null,
      canceledByName: null,
      cancellationApprovedByEmployeeId: null,
      cancellationApprovedByEmployeeName: null,
      cancellationApprovedAt: null,
      cancelReason: null,
    },
  })

  if (paymentUpdate.count === 0) {
    return (await db.restaurantOrder.findFirst({
      where: {
        id: params.orderId,
        restaurantId: params.restaurantId,
        branchId: params.branchId,
      },
      include: { items: { where: { status: 'ACTIVE' } } },
    })) ?? currentOrder
  }

  const paidOrder = await db.restaurantOrder.findFirst({
    where: {
      id: params.orderId,
      restaurantId: params.restaurantId,
      branchId: params.branchId,
    },
    include: { items: { where: { status: 'ACTIVE' } } },
  })

  if (!paidOrder) {
    throw new Error('Order not found after payment update')
  }

  await recordDishSalesForPaidOrder(db, {
    billingUserId: params.billingUserId,
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    includeBranchlessRows: params.includeBranchlessRows,
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
    userId: params.billingUserId,
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    date: paidOrder.paidAt ?? paidAt,
    description: transactionDescription,
    amount: journalAmount,
    direction: 'in',
    accountName: 'DishSale',
    categoryType: 'income',
    paymentMethod: normalizedPaymentMethod,
    isManual: false,
    sourceKind: 'dish_sale_mirror',
    authoritativeForRevenue: false,
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