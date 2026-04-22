import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { resolveCancellationApprover } from '@/lib/cancelApproval'
import { calculateRestaurantOrderTotals, enqueueOrderSync, generateRestaurantOrderNumber, isRestaurantOrderNumberConflict, syncRestaurantOrderTotals } from '@/lib/restaurantOrders'
import { findRestaurantAction, isRestaurantActionConflict, normalizeRestaurantActionKey, recordRestaurantAction } from '@/lib/restaurantAction'
import { enqueueRestaurantTableSync } from '@/lib/restaurantTableSync'

const PENDING_TRANSACTION_OPTIONS = {
  maxWait: 10000,
  timeout: 20000,
} as const

export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json([])

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json([])

  const searchParams = new URL(req.url).searchParams
  const includeServed = ['1', 'true', 'yes'].includes((searchParams.get('includeServed') ?? '').toLowerCase())

  const orders = await prisma.restaurantOrder.findMany({
    where: {
      restaurantId: context.restaurantId,
      branchId: context.branchId,
      status: 'PENDING',
      ...(includeServed ? {} : { servedAt: null }),
    },
    include: {
      items: {
        where: { status: 'ACTIVE' },
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { createdAt: 'asc' },
  })

  const flattened = orders.flatMap((order) =>
    order.items.map((item) => ({
      id: item.id,
      orderId: order.id,
      orderNumber: order.orderNumber,
      tableId: order.tableId,
      tableName: order.tableName,
      dishId: item.dishId,
      dishName: item.dishName,
      dishPrice: item.dishPrice,
      qty: item.qty,
      status: item.kitchenStatus,
      waiter: { id: order.createdById, name: order.createdByName },
      addedAt: order.createdAt,
      readyAt: item.readyAt,
      orderServedAt: order.servedAt,
      paymentMethod: order.paymentMethod,
      totalAmount: order.totalAmount,
      notes: null,
    }))
  )

  return NextResponse.json(flattened)
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  if (!context?.restaurantId || !context.branchId) return NextResponse.json({ error: 'No restaurant branch found' }, { status: 400 })

  const restaurantId = context.restaurantId
  const branchId = context.branchId

  const { tableId, tableName, waiterName, dishId, dishName, dishPrice, qty, actionKey } = await req.json()
  const normalizedActionKey = normalizeRestaurantActionKey(actionKey)
  const normalizedWaiterName = String(waiterName ?? '').trim()

  if (!normalizedWaiterName) {
    return NextResponse.json({ error: 'Waiter name is required before confirming this order.' }, { status: 400 })
  }

  const normalizedTableId = tableId === 'takeaway' ? null : tableId || null
  const normalizedTableName = tableName || 'Takeaway'
  const normalizedDishPrice = Number(dishPrice)
  const normalizedQty = Number(qty) || 1
  const itemTotals = calculateRestaurantOrderTotals([{ dishPrice: normalizedDishPrice, qty: normalizedQty }])

  let created: { activeOrder: { id: string; tableId: string | null }; item: { id: string } } | null = null

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      created = await prisma.$transaction(async (tx) => {
        let activeOrder = await tx.restaurantOrder.findFirst({
          where: {
            restaurantId,
            branchId,
            status: 'PENDING',
            tableId: normalizedTableId,
            ...(normalizedTableId === null ? { tableName: normalizedTableName } : {}),
          },
          orderBy: { createdAt: 'desc' },
        })

        if (!activeOrder) {
          activeOrder = await tx.restaurantOrder.create({
            data: {
              restaurantId,
              branchId,
              tableId: normalizedTableId,
              tableName: normalizedTableName,
              orderNumber: await generateRestaurantOrderNumber(tx, restaurantId, branchId),
              createdById: session.user.id,
              createdByName: normalizedWaiterName,
            },
          })
        }

        const item = await tx.restaurantOrderItem.create({
          data: {
            orderId: activeOrder.id,
            dishId,
            dishName,
            dishPrice: normalizedDishPrice,
            qty: normalizedQty,
          },
        })

        const updatedOrder = await tx.restaurantOrder.update({
          where: { id: activeOrder.id },
          data: {
            subtotalAmount: { increment: itemTotals.subtotalAmount },
            vatAmount: { increment: itemTotals.vatAmount },
            totalAmount: { increment: itemTotals.totalAmount },
          },
          select: {
            id: true,
            tableId: true,
            tableName: true,
          },
        })

        await enqueueOrderSync(tx, activeOrder.id, restaurantId, branchId)

        if (normalizedActionKey) {
          await recordRestaurantAction(tx, {
            restaurantId,
            branchId,
            userId: session.user.id,
            actionKey: normalizedActionKey,
            actionType: 'pending.create',
            orderId: updatedOrder.id,
            orderItemId: item.id,
            tableId: updatedOrder.tableId,
            tableName: updatedOrder.tableName,
          })
        }

        return { activeOrder: updatedOrder, item }
      }, PENDING_TRANSACTION_OPTIONS)
      break
    } catch (error) {
      if (normalizedActionKey && isRestaurantActionConflict(error)) {
        const existingAction = await findRestaurantAction(restaurantId, normalizedActionKey, branchId)
        const existingItem = existingAction?.orderItemId
          ? await prisma.restaurantOrderItem.findUnique({ where: { id: existingAction.orderItemId } })
          : null
        return NextResponse.json({ duplicate: true, action: existingAction, item: existingItem }, { status: 200 })
      }

      if (!isRestaurantOrderNumberConflict(error) || attempt === 4) throw error
    }
  }

  if (!created) {
    return NextResponse.json({ error: 'Failed to confirm order' }, { status: 500 })
  }

  // Mark table as occupied if it's a real table
  if (normalizedTableId) {
    await prisma.restaurantTable.updateMany({
      where: { id: normalizedTableId, restaurantId, branchId },
      data: { status: 'occupied' }
    })
    await enqueueRestaurantTableSync(prisma, normalizedTableId, restaurantId)
  }

  return NextResponse.json(created, { status: 201 })
}

export async function DELETE(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = await getRestaurantContextForUser(session.user.id)
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null
  if (!restaurantId || !branchId || !context) return NextResponse.json({ error: 'No restaurant branch' }, { status: 400 })

  const { orderId, tableKey, clearTable, cancelReason, supervisorPin, actionKey } = await req.json()
  const reason = String(cancelReason || 'Canceled by staff').trim()
  const normalizedActionKey = normalizeRestaurantActionKey(actionKey)

  const approver = await resolveCancellationApprover({
    billingUserId: context.billingUserId,
    restaurantId,
    branchId,
    pin: String(supervisorPin || ''),
  })
  if (!approver) {
    return NextResponse.json({ error: 'A valid 5-digit supervisor PIN is required' }, { status: 403 })
  }
  const cancellationRecorderId = approver.id
  const cancellationRecorderName = approver.name

  if (orderId) {
    const item = await prisma.restaurantOrderItem.findFirst({
      where: { id: orderId, order: { restaurantId, branchId, status: 'PENDING' } },
      include: { order: true },
    })

    if (!item) return NextResponse.json({ error: 'Order item not found' }, { status: 404 })

    try {
      await prisma.$transaction(async (tx) => {
      await tx.restaurantOrderItem.update({
        where: { id: orderId },
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

      const remaining = await tx.restaurantOrderItem.count({
        where: { orderId: item.orderId, status: 'ACTIVE' },
      })

      if (remaining === 0) {
        await tx.restaurantOrder.update({
          where: { id: item.orderId },
          data: {
            status: 'CANCELED',
            canceledAt: new Date(),
            canceledById: cancellationRecorderId,
            canceledByName: cancellationRecorderName,
            cancellationApprovedByEmployeeId: approver.id,
            cancellationApprovedByEmployeeName: approver.name,
            cancellationApprovedAt: new Date(),
            cancelReason: reason,
          },
        })

        if (item.order.tableId) {
          await tx.restaurantTable.updateMany({
            where: { id: item.order.tableId, restaurantId, branchId },
            data: { status: 'available' },
          })
          await enqueueRestaurantTableSync(tx, item.order.tableId, restaurantId)
        }
      } else {
        await syncRestaurantOrderTotals(tx, item.orderId)
      }
      await enqueueOrderSync(tx, item.orderId, restaurantId, branchId)
      if (normalizedActionKey) {
        await recordRestaurantAction(tx, {
          restaurantId,
          branchId,
          userId: session.user.id,
          actionKey: normalizedActionKey,
          actionType: 'pending.cancel-item',
          orderId: item.orderId,
          orderItemId: orderId,
          tableId: item.order.tableId,
          tableName: item.order.tableName,
        })
      }
    }, PENDING_TRANSACTION_OPTIONS)
    } catch (error) {
      if (!normalizedActionKey || !isRestaurantActionConflict(error)) throw error
      const existingAction = await findRestaurantAction(restaurantId, normalizedActionKey, branchId)
      return NextResponse.json({ ok: true, duplicate: true, action: existingAction })
    }
  } else if (tableKey) {
    const tableId = tableKey === 'takeaway' ? null : tableKey
    const targetOrders = await prisma.restaurantOrder.findMany({
      where: {
        restaurantId,
        branchId,
        status: 'PENDING',
        tableId,
        ...(tableId === null ? { tableName: 'Takeaway' } : {}),
      },
      select: { id: true },
    })

    try {
      await prisma.$transaction(async (tx) => {
      for (const targetOrder of targetOrders) {
        await tx.restaurantOrderItem.updateMany({
          where: { orderId: targetOrder.id, status: 'ACTIVE' },
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

        await tx.restaurantOrder.update({
          where: { id: targetOrder.id },
          data: {
            status: 'CANCELED',
            canceledAt: new Date(),
            canceledById: cancellationRecorderId,
            canceledByName: cancellationRecorderName,
            cancellationApprovedByEmployeeId: approver.id,
            cancellationApprovedByEmployeeName: approver.name,
            cancellationApprovedAt: new Date(),
            cancelReason: reason,
          },
        })
        await enqueueOrderSync(tx, targetOrder.id, restaurantId, branchId)
      }

      // Mark table available
      if (clearTable && tableId) {
        await tx.restaurantTable.updateMany({
          where: { id: tableId, restaurantId, branchId },
          data: { status: 'available' }
        })
        await enqueueRestaurantTableSync(tx, tableId, restaurantId)
      }
      if (normalizedActionKey) {
        await recordRestaurantAction(tx, {
          restaurantId,
          branchId,
          userId: session.user.id,
          actionKey: normalizedActionKey,
          actionType: 'pending.cancel-table',
          tableId,
          tableName: tableId ? null : 'Takeaway',
        })
      }
    }, PENDING_TRANSACTION_OPTIONS)
    } catch (error) {
      if (!normalizedActionKey || !isRestaurantActionConflict(error)) throw error
      const existingAction = await findRestaurantAction(restaurantId, normalizedActionKey, branchId)
      return NextResponse.json({ ok: true, duplicate: true, action: existingAction })
    }
  }

  return NextResponse.json({ ok: true })
}
