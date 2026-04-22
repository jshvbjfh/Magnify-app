import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser, isMainRestaurantBranch } from '@/lib/restaurantAccess'
import { resolveCancellationApprover } from '@/lib/cancelApproval'
import { InsufficientFifoStockError, InsufficientInventoryStockError, recordDishSalesForPaidOrder, recordDishWasteForOrderItems } from '@/lib/dishSaleRecording'
import { syncRestaurantOrderTotals, enqueueOrderSync } from '@/lib/restaurantOrders'
import { recordJournalEntry } from '@/lib/accounting'
import { findRestaurantAction, isRestaurantActionConflict, normalizeRestaurantActionKey, recordRestaurantAction } from '@/lib/restaurantAction'
import { enqueueRestaurantTableSync } from '@/lib/restaurantTableSync'

const ORDER_TRANSACTION_OPTIONS = {
  maxWait: 10000,
  timeout: 20000,
} as const

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

function buildStockShortageResponse(error: InsufficientFifoStockError | InsufficientInventoryStockError) {
  return NextResponse.json({
    error: error.message,
    code: error instanceof InsufficientFifoStockError ? 'FIFO_STOCK_SHORTAGE' : 'INVENTORY_STOCK_SHORTAGE',
    details: {
      ingredientId: error.ingredientId,
      ingredientName: error.ingredientName,
      requiredQuantity: error.requiredQuantity,
      availableQuantity: error.availableQuantity,
      unit: error.unit,
    },
  }, { status: 409 })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })
  const includeBranchlessRows = await isMainRestaurantBranch(context.restaurantId, context.branchId)

  const { id } = await params
  const { action, cancelReason, paymentMethod, supervisorPin, actionKey } = await req.json()
  const normalizedActionKey = normalizeRestaurantActionKey(actionKey)

  const order = await prisma.restaurantOrder.findFirst({
    where: { id, restaurantId: context.restaurantId, branchId: context.branchId },
    include: { items: { where: { status: 'ACTIVE' } } },
  })
  if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 })

  async function getCurrentOrderSnapshot() {
    return prisma.restaurantOrder.findFirst({
      where: { id, restaurantId: context.restaurantId, branchId: context.branchId },
      include: { items: { where: { status: 'ACTIVE' } } },
    })
  }

  async function resolveDuplicateActionResponse() {
    if (!normalizedActionKey) return null
    const existingAction = await findRestaurantAction(context.restaurantId, normalizedActionKey, context.branchId)
    const currentOrder = await getCurrentOrderSnapshot()
    return NextResponse.json({ duplicate: true, action: existingAction, order: currentOrder }, { status: 200 })
  }

  if (action === 'serve') {
    try {
      const updated = await prisma.$transaction(async (tx) => {
        const servedOrder = await tx.restaurantOrder.update({
          where: { id },
          data: {
            servedAt: order.servedAt ?? new Date(),
            servedById: session.user.id,
            servedByName: session.user.name ?? 'Staff',
          },
        })

        await enqueueOrderSync(tx, id, context.restaurantId, context.branchId)

        if (normalizedActionKey) {
          await recordRestaurantAction(tx, {
            restaurantId: context.restaurantId,
            branchId: context.branchId,
            userId: session.user.id,
            actionKey: normalizedActionKey,
            actionType: 'order.serve',
            orderId: id,
            tableId: order.tableId,
            tableName: order.tableName,
          })
        }

        return servedOrder
      }, ORDER_TRANSACTION_OPTIONS)
      return NextResponse.json(updated)
    } catch (error) {
      if (!normalizedActionKey || !isRestaurantActionConflict(error)) throw error
      return (await resolveDuplicateActionResponse()) ?? NextResponse.json(order)
    }
  }

  if (action === 'pay') {
    if (order.status === 'PAID') {
      return NextResponse.json(order)
    }

    const normalizedPaymentMethod = paymentMethod || order.paymentMethod || 'Cash'
    try {
      const updated = await prisma.$transaction(async (tx) => {
        const currentOrder = await tx.restaurantOrder.findFirst({
          where: { id, restaurantId: context.restaurantId, branchId: context.branchId },
          include: { items: { where: { status: 'ACTIVE' } } },
        })
        if (!currentOrder) {
          throw new Error('Order not found')
        }

        if (currentOrder.status === 'PAID') {
          return currentOrder
        }

        const syncedOrder = await syncRestaurantOrderTotals(tx, id)
        const paidAt = new Date()
        const paymentRecordedByName = currentOrder.createdByName.trim() || session.user.name?.trim() || 'Staff'
        const transactionDescription = buildDishSaleTransactionDescription({
          items: currentOrder.items.map((item) => ({
            dishId: item.dishId,
            dishName: item.dishName,
            qty: item.qty,
          })),
          tableId: currentOrder.tableId,
          tableName: currentOrder.tableName,
        })
        const paymentUpdate = await tx.restaurantOrder.updateMany({
          where: {
            id,
            restaurantId: context.restaurantId,
            branchId: context.branchId,
            status: 'PENDING',
          },
          data: {
            status: 'PAID',
            paymentMethod: normalizedPaymentMethod,
            paidAt,
            paidById: session.user.id,
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
          return (await tx.restaurantOrder.findFirst({
            where: { id, restaurantId: context.restaurantId, branchId: context.branchId },
            include: { items: { where: { status: 'ACTIVE' } } },
          })) ?? currentOrder
        }

        const paidOrder = await tx.restaurantOrder.findFirst({
          where: { id, restaurantId: context.restaurantId, branchId: context.branchId },
          include: { items: { where: { status: 'ACTIVE' } } },
        })
        if (!paidOrder) {
          throw new Error('Order not found after payment update')
        }

        await recordDishSalesForPaidOrder(tx, {
          billingUserId: context.billingUserId,
          restaurantId: context.restaurantId,
          branchId: context.branchId,
          includeBranchlessRows,
          orderId: id,
          paymentMethod: normalizedPaymentMethod,
          saleDate: paidAt,
          items: currentOrder.items.map((item) => ({
            dishId: item.dishId,
            dishPrice: item.dishPrice,
            qty: item.qty,
          })),
        })

        await recordJournalEntry(tx, {
          userId: context.billingUserId,
          restaurantId: context.restaurantId,
          branchId: context.branchId,
          date: paidOrder.paidAt ?? paidAt,
          description: transactionDescription,
          amount: syncedOrder.totalAmount,
          direction: 'in',
          accountName: 'DishSale',
          categoryType: 'income',
          paymentMethod: normalizedPaymentMethod,
          isManual: false,
          sourceKind: 'dish_sale_mirror',
          authoritativeForRevenue: false,
        })

        if (currentOrder.tableId) {
          await tx.restaurantTable.updateMany({
            where: { id: currentOrder.tableId, restaurantId: context.restaurantId, branchId: context.branchId },
            data: { status: 'available' },
          })
          await enqueueRestaurantTableSync(tx, currentOrder.tableId, context.restaurantId)
        }

        if (normalizedActionKey) {
          await recordRestaurantAction(tx, {
            restaurantId: context.restaurantId,
            branchId: context.branchId,
            userId: session.user.id,
            actionKey: normalizedActionKey,
            actionType: 'order.pay',
            orderId: id,
            tableId: currentOrder.tableId,
            tableName: currentOrder.tableName,
          })
        }

        await enqueueOrderSync(tx, id, context.restaurantId, context.branchId)

        return paidOrder
      }, ORDER_TRANSACTION_OPTIONS)

      return NextResponse.json(updated)
    } catch (error) {
      if (error instanceof InsufficientFifoStockError || error instanceof InsufficientInventoryStockError) {
        return buildStockShortageResponse(error)
      }

      if (!normalizedActionKey || !isRestaurantActionConflict(error)) throw error
      return (await resolveDuplicateActionResponse()) ?? NextResponse.json(order)
    }
  }

  if (action === 'cancel') {
    const approver = await resolveCancellationApprover({
      billingUserId: context.billingUserId,
      restaurantId: context.restaurantId,
      branchId: context.branchId,
      pin: String(supervisorPin || ''),
    })
    if (!approver) {
      return NextResponse.json({ error: 'A valid 5-digit supervisor PIN is required' }, { status: 403 })
    }

    const reason = String(cancelReason || 'Canceled by staff').trim()
    const cancellationRecorderId = approver.id
    const cancellationRecorderName = approver.name
    try {
      const updated = await prisma.$transaction(async (tx) => {
      await tx.restaurantOrderItem.updateMany({
        where: { orderId: id, status: 'ACTIVE' },
        data: {
          status: 'CANCELED',
          canceledById: cancellationRecorderId,
          canceledByName: cancellationRecorderName,
          cancellationApprovedByEmployeeId: approver.id,
          cancellationApprovedByEmployeeName: approver.name,
          cancelReason: reason,
          canceledAt: new Date(),
        },
      })

      const canceled = await tx.restaurantOrder.update({
        where: { id },
        data: {
          status: 'CANCELED',
          canceledAt: new Date(),
          canceledById: cancellationRecorderId,
          canceledByName: cancellationRecorderName,
          cancellationApprovedByEmployeeId: approver.id,
          cancellationApprovedByEmployeeName: approver.name,
          cancellationApprovedAt: new Date(),
          cancelReason: reason,
          servedAt: order.servedAt,
        },
      })

      if (order.tableId) {
        await tx.restaurantTable.updateMany({
          where: { id: order.tableId, restaurantId: context.restaurantId, branchId: context.branchId },
          data: { status: 'available' },
        })
        await enqueueRestaurantTableSync(tx, order.tableId, context.restaurantId)
      }

      if (normalizedActionKey) {
        await recordRestaurantAction(tx, {
          restaurantId: context.restaurantId,
          branchId: context.branchId,
          userId: session.user.id,
          actionKey: normalizedActionKey,
          actionType: 'order.cancel',
          orderId: id,
          tableId: order.tableId,
          tableName: order.tableName,
        })
      }

      await enqueueOrderSync(tx, id, context.restaurantId, context.branchId)

      return canceled
    }, ORDER_TRANSACTION_OPTIONS)

    return NextResponse.json(updated)
    } catch (error) {
      if (!normalizedActionKey || !isRestaurantActionConflict(error)) throw error
      return (await resolveDuplicateActionResponse()) ?? NextResponse.json(order)
    }
  }

  if (action === 'waste') {
    const approver = await resolveCancellationApprover({
      billingUserId: context.billingUserId,
      restaurantId: context.restaurantId,
      branchId: context.branchId,
      pin: String(supervisorPin || ''),
    })
    if (!approver) {
      return NextResponse.json({ error: 'A valid 5-digit supervisor PIN is required' }, { status: 403 })
    }

    const reason = String(cancelReason || 'Marked as wasted').trim() || 'Marked as wasted'
    const wasteableItems = order.items.filter((item) => ['in_kitchen', 'ready'].includes(item.kitchenStatus))
    if (!wasteableItems.length) {
      return NextResponse.json({ error: 'Only dishes already in kitchen or ready can be marked as wasted' }, { status: 400 })
    }

    try {
      const updated = await prisma.$transaction(async (tx) => {
      const wastedAt = new Date()

      await tx.restaurantOrderItem.updateMany({
        where: {
          orderId: id,
          status: 'ACTIVE',
          kitchenStatus: { in: ['in_kitchen', 'ready'] },
        },
        data: {
          status: 'WASTED',
          wastedById: session.user.id,
          wastedByName: session.user.name ?? 'Staff',
          cancellationApprovedByEmployeeId: approver.id,
          cancellationApprovedByEmployeeName: approver.name,
          wasteReason: reason,
          wasteAcknowledged: false,
          wastedAt,
        },
      })

      await recordDishWasteForOrderItems(tx, {
        billingUserId: context.billingUserId,
        restaurantId: context.restaurantId,
        branchId: context.branchId,
        includeBranchlessRows,
        orderId: id,
        orderLabel: `${order.orderNumber} · ${formatOrderLocation(order.tableId, order.tableName)}`,
        wasteDate: wastedAt,
        reason,
        items: wasteableItems.map((item) => ({
          dishId: item.dishId,
          dishName: item.dishName,
          qty: item.qty,
        })),
      })

      const remainingActiveItems = await tx.restaurantOrderItem.count({
        where: { orderId: id, status: 'ACTIVE' },
      })

      if (remainingActiveItems === 0) {
        const canceledOrder = await tx.restaurantOrder.update({
          where: { id },
          data: {
            status: 'CANCELED',
            canceledAt: wastedAt,
            canceledById: session.user.id,
            canceledByName: session.user.name ?? 'Staff',
            cancellationApprovedByEmployeeId: approver.id,
            cancellationApprovedByEmployeeName: approver.name,
            cancellationApprovedAt: wastedAt,
            cancelReason: 'All items were marked as wasted',
            servedAt: order.servedAt,
          },
        })

        if (order.tableId) {
          await tx.restaurantTable.updateMany({
            where: { id: order.tableId, restaurantId: context.restaurantId, branchId: context.branchId },
            data: { status: 'available' },
          })
          await enqueueRestaurantTableSync(tx, order.tableId, context.restaurantId)
        }

        if (normalizedActionKey) {
          await recordRestaurantAction(tx, {
            restaurantId: context.restaurantId,
            branchId: context.branchId,
            userId: session.user.id,
            actionKey: normalizedActionKey,
            actionType: 'order.waste',
            orderId: id,
            tableId: order.tableId,
            tableName: order.tableName,
          })
        }

        await enqueueOrderSync(tx, id, context.restaurantId, context.branchId)

        return canceledOrder
      }

      const currentOrder = await syncRestaurantOrderTotals(tx, id)

      if (normalizedActionKey) {
        await recordRestaurantAction(tx, {
          restaurantId: context.restaurantId,
          branchId: context.branchId,
          userId: session.user.id,
          actionKey: normalizedActionKey,
          actionType: 'order.waste',
          orderId: id,
          tableId: order.tableId,
          tableName: order.tableName,
        })
      }

      await enqueueOrderSync(tx, id, context.restaurantId, context.branchId)

      return currentOrder
    }, ORDER_TRANSACTION_OPTIONS)

    return NextResponse.json(updated)
    } catch (error) {
      if (error instanceof InsufficientFifoStockError || error instanceof InsufficientInventoryStockError) {
        return buildStockShortageResponse(error)
      }

      if (!normalizedActionKey || !isRestaurantActionConflict(error)) throw error
      return (await resolveDuplicateActionResponse()) ?? NextResponse.json(order)
    }
  }

  return NextResponse.json({ error: 'Unsupported action' }, { status: 400 })
}