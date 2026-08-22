import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { resolveCancellationApprover } from '@/lib/cancelApproval'
import { InsufficientFifoStockError, InsufficientInventoryStockError, recordDishWasteForOrderItems } from '@/lib/dishSaleRecording'
import { enqueueOrderSync, isNoChargeMethod, syncRestaurantOrderTotals } from '@/lib/restaurantOrders'
import { finalizeRestaurantOrderPayment } from '@/lib/restaurantOrderPayment'
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

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant station found' }, { status: 400 })
  const restaurantId = context.restaurantId
  const branchId = context.branchId

  const { id } = await params
  const { action, cancelReason, paymentMethod, customerName, customerPhone, noChargeReason, supervisorPin, actionKey } = await req.json()
  const normalizedActionKey = normalizeRestaurantActionKey(actionKey)

  // Main is not another station — it oversees them all, so a receivable
  // collected from it has to reach a tab taken anywhere in the restaurant.
  // Without this the A/R list on Main showed tabs it then refused to collect,
  // 404ing because the order belonged to the station that served it.
  //
  // Only collection is widened. Serving, paying and cancelling stay tied to the
  // till that owns the order, because those are floor actions and the station
  // holding the table is the one that may take them.
  const collectingFromMain = action === 'collect-ar'
    ? Boolean((await prisma.branch.findFirst({
        where: { id: branchId, restaurantId },
        select: { isMain: true },
      }))?.isMain)
    : false

  const order = await prisma.restaurantOrder.findFirst({
    where: collectingFromMain ? { id, restaurantId } : { id, restaurantId, branchId },
    include: { items: { where: { status: 'ACTIVE' } } },
  })
  if (!order) return NextResponse.json({ error: 'Order not found' }, { status: 404 })

  async function getCurrentOrderSnapshot() {
    return prisma.restaurantOrder.findFirst({
      where: { id, restaurantId, branchId },
      include: { items: { where: { status: 'ACTIVE' } } },
    })
  }

  async function resolveDuplicateActionResponse() {
    if (!normalizedActionKey) return null
    const existingAction = await findRestaurantAction(restaurantId, normalizedActionKey, branchId)
    const currentOrder = await getCurrentOrderSnapshot()
    return NextResponse.json({ duplicate: true, action: existingAction, order: currentOrder }, { status: 200 })
  }

  if (action === 'serve') {
    try {
      const updated = await prisma.$transaction(async (tx) => {
        const servedOrder = await tx.restaurantOrder.findFirst({
          where: { id },
          include: { items: { where: { status: 'ACTIVE' } } },
        }) ?? order

        await enqueueOrderSync(tx, id, restaurantId, branchId)

        if (normalizedActionKey) {
          await recordRestaurantAction(tx, {
            restaurantId,
            branchId,
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

    // A comp with no reason is indistinguishable from a mistake, and it is the
    // only thing the No Charge report can say about why the food went out. The
    // till has always demanded one; refusing here means the dashboard cannot
    // become the quiet way around that.
    const comped = isNoChargeMethod(normalizedPaymentMethod)
    const trimmedNoChargeReason = typeof noChargeReason === 'string' ? noChargeReason.trim() : ''
    if (comped && !trimmedNoChargeReason) {
      return NextResponse.json({ error: 'A reason is required to settle a bill as Complementary' }, { status: 400 })
    }

    try {
      const updated = await prisma.$transaction(async (tx) => {
        const paidOrder = await finalizeRestaurantOrderPayment(tx, {
          restaurantId,
          branchId,
          orderId: id,
          paymentMethod: normalizedPaymentMethod,
          arCustomerName: customerName || null,
          arCustomerPhone: customerPhone || null,
          noChargeReason: comped ? trimmedNoChargeReason : null,
          // Whoever is signed into the dashboard is the one closing this bill.
          // createdByName is left alone, so the sale stays with the waiter who
          // took the table.
          settledByName: session.user.name?.trim() || null,
        })

        if (normalizedActionKey) {
          await recordRestaurantAction(tx, {
            restaurantId,
            branchId,
            userId: session.user.id,
            actionKey: normalizedActionKey,
            actionType: 'order.pay',
            orderId: id,
            tableId: paidOrder.tableId,
            tableName: paidOrder.tableName,
          })
        }

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

  if (action === 'collect-ar') {
    if (order.status !== 'PAID' || order.paymentMethod !== 'Credit') {
      return NextResponse.json({ error: 'Order is not an outstanding credit sale' }, { status: 400 })
    }
    if (order.arCollectedAt) {
      return NextResponse.json({ error: 'This receivable has already been collected' }, { status: 409 })
    }

    const collectPaymentMethod = paymentMethod || 'Cash'
    try {
      const updated = await prisma.$transaction(async (tx) => {
        // Shared with the A/R page, so a receivable clears the same way whether
        // it was collected at the till or from the owner's Receivable screen.
        const { recordReceivableCollection } = await import('@/lib/accounting')
        await recordReceivableCollection(tx, {
          restaurantId,
          // The station that served the food, not the till that took the money.
          // Collecting from Main must not move the entry onto Main's books.
          branchId: order.branchId ?? branchId,
          amount: order.totalAmount,
          paymentMethod: collectPaymentMethod,
          subject: `Order ${order.orderNumber}`,
          customerName: order.arCustomerName,
          reference: `AR-${order.id.slice(-8).toUpperCase()}`,
        })

        return tx.restaurantOrder.update({
          where: { id },
          data: { arCollectedAt: new Date() },
          include: { items: { where: { status: 'ACTIVE' } } },
        })
      }, ORDER_TRANSACTION_OPTIONS)

      return NextResponse.json(updated)
    } catch (error) {
      if (!normalizedActionKey || !isRestaurantActionConflict(error)) throw error
      return (await resolveDuplicateActionResponse()) ?? NextResponse.json(order)
    }
  }

  if (action === 'cancel') {
    const approver = await resolveCancellationApprover({
      restaurantId,
      branchId,
      pin: String(supervisorPin || ''),
    })
    if (!approver) {
      return NextResponse.json({ error: 'A valid supervisor PIN is required' }, { status: 403 })
    }

    const reason = String(cancelReason || 'Canceled by staff').trim()
    try {
      const updated = await prisma.$transaction(async (tx) => {
        await tx.orderItem.updateMany({
          where: { orderId: id, status: 'ACTIVE' },
          data: {
            status: 'CANCELED',
            cancelReason: reason,
            canceledAt: new Date(),
          },
        })

        const canceled = await tx.restaurantOrder.update({
          where: { id },
          data: {
            status: 'CANCELED',
            canceledAt: new Date(),
            cancelReason: reason,
          },
        })

        if (order.tableId) {
          await tx.restaurantTable.updateMany({
            where: { id: order.tableId, restaurantId, branchId },
            data: { status: 'available' },
          })
          await enqueueRestaurantTableSync(tx, order.tableId, restaurantId)
        }

        if (normalizedActionKey) {
          await recordRestaurantAction(tx, {
            restaurantId,
            branchId,
            userId: session.user.id,
            actionKey: normalizedActionKey,
            actionType: 'order.cancel',
            orderId: id,
            tableId: order.tableId,
            tableName: order.tableName,
          })
        }

        await enqueueOrderSync(tx, id, restaurantId, branchId)

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
      restaurantId,
      branchId,
      pin: String(supervisorPin || ''),
    })
    if (!approver) {
      return NextResponse.json({ error: 'A valid supervisor PIN is required' }, { status: 403 })
    }

    const reason = String(cancelReason || 'Marked as wasted').trim() || 'Marked as wasted'
    const wasteableItems = order.items.filter((item) => ['in_kitchen', 'ready'].includes(item.kitchenStatus))
    if (!wasteableItems.length) {
      return NextResponse.json({ error: 'Only dishes already in kitchen or ready can be marked as wasted' }, { status: 400 })
    }

    try {
      const updated = await prisma.$transaction(async (tx) => {
        const wastedAt = new Date()

        await tx.orderItem.updateMany({
          where: {
            orderId: id,
            status: 'ACTIVE',
            kitchenStatus: { in: ['in_kitchen', 'ready'] },
          },
          data: {
            status: 'WASTED',
            cancelReason: reason,
            canceledAt: wastedAt,
          },
        })

        await recordDishWasteForOrderItems(tx, {
          restaurantId,
          branchId,
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

        const remainingActiveItems = await tx.orderItem.count({
          where: { orderId: id, status: 'ACTIVE' },
        })

        if (remainingActiveItems === 0) {
          const canceledOrder = await tx.restaurantOrder.update({
            where: { id },
            data: {
              status: 'CANCELED',
              canceledAt: wastedAt,
              cancelReason: 'All items were marked as wasted',
            },
          })

          if (order.tableId) {
            await tx.restaurantTable.updateMany({
              where: { id: order.tableId, restaurantId, branchId },
              data: { status: 'available' },
            })
            await enqueueRestaurantTableSync(tx, order.tableId, restaurantId)
          }

          if (normalizedActionKey) {
            await recordRestaurantAction(tx, {
              restaurantId,
              branchId,
              userId: session.user.id,
              actionKey: normalizedActionKey,
              actionType: 'order.waste',
              orderId: id,
              tableId: order.tableId,
              tableName: order.tableName,
            })
          }

          await enqueueOrderSync(tx, id, restaurantId, branchId)

          return canceledOrder
        }

        const currentOrder = await syncRestaurantOrderTotals(tx, id)

        if (normalizedActionKey) {
          await recordRestaurantAction(tx, {
            restaurantId,
            branchId,
            userId: session.user.id,
            actionKey: normalizedActionKey,
            actionType: 'order.waste',
            orderId: id,
            tableId: order.tableId,
            tableName: order.tableName,
          })
        }

        await enqueueOrderSync(tx, id, restaurantId, branchId)

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
