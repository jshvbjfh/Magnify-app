import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { jwtVerify } from 'jose'
import { getRestaurantContextForUser } from '@/lib/restaurantAccess'
import { enqueueOrderSync } from '@/lib/restaurantOrders'
import { finalizeRestaurantOrderPayment } from '@/lib/restaurantOrderPayment'

export const dynamic = 'force-dynamic'

const SECRET = new TextEncoder().encode(
  process.env.NEXTAUTH_SECRET ?? 'fallback-secret-change-me'
)

const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, max-age=0, must-revalidate',
}

function jsonNoStore(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: {
      ...NO_STORE_HEADERS,
      ...(init?.headers ?? {}),
    },
  })
}

async function verifyToken(req: Request) {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) throw new Error('Unauthorized')
  const { payload } = await jwtVerify(token, SECRET)
  return payload as { sub: string; restaurantId: string; branchId: string | null; role: string }
}

interface MobileOrder {
  id: string
  restaurant_id: string
  branch_id: string | null
  table_id: string | null
  table_name: string | null
  order_number: string | null
  status: string
  payment_method: string | null
  subtotal_amount: number
  vat_amount: number
  total_amount: number
  created_by_name: string | null
  served_at: string | null
  paid_at: string | null
  canceled_at: string | null
  cancel_reason: string | null
  created_at: string
  updated_at: string
}

interface MobileOrderItem {
  id: string
  order_id: string
  dish_id: string
  dish_name: string
  dish_price: number
  qty: number
  status: string
  created_at: string
  updated_at: string
}

/** POST /api/mobile/push — accepts orders from the waiter APK and writes to Neon */
export async function POST(req: Request) {
  try {
    const claims = await verifyToken(req)
    const { restaurantId, branchId } = claims
    const context = await getRestaurantContextForUser(claims.sub)
    const mobileSourceDeviceId = `mobile:${claims.sub}`

    if (!context?.restaurantId || context.restaurantId !== restaurantId) {
      return jsonNoStore({ error: 'Unauthorized' }, { status: 401 })
    }

    const includeBranchlessRows = Boolean(branchId)

    const { orders, orderItems } = (await req.json()) as {
      orders: MobileOrder[]
      orderItems: MobileOrderItem[]
    }

    if (!Array.isArray(orders) || !orders.length) {
      return jsonNoStore({ ok: true, syncedOrderIds: [] })
    }

    const syncedOrderIds: string[] = []

    for (const order of orders) {
      // Security: ensure the order belongs to the authenticated restaurant
      if (order.restaurant_id !== restaurantId) continue

      // Security: reject orders claiming a branch the waiter is not assigned to.
      // The JWT branchId is the authoritative value — never trust the client payload.
      if (branchId && order.branch_id && order.branch_id !== branchId) continue

      const items = orderItems.filter(i => i.order_id === order.id)

      // Always stamp with the JWT-verified branchId and createdById.
      // createdById is a non-nullable column; the waiter's user ID is in claims.sub.
      const resolvedBranchId = branchId ?? null

      await prisma.$transaction(async (tx) => {
        const existingOrder = await tx.restaurantOrder.findFirst({
          where: { id: order.id, restaurantId: order.restaurant_id },
          select: { status: true },
        })

        // If the existing order is already PAID but has no dish sales (e.g. a
        // previous transaction timed out after committing the status update but
        // before recording sales), we still need to finalize so dish sales and
        // inventory deductions are created.  recordDishSalesForPaidOrder is
        // idempotent, so calling it again for a fully-processed order is safe.
        const existingMissingDishSales =
          order.status === 'PAID' && existingOrder?.status === 'PAID'
            ? (await tx.dishSale.count({ where: { orderId: order.id } })) === 0
            : false
        const shouldFinalizePaidOrder =
          order.status === 'PAID' && (existingOrder?.status !== 'PAID' || existingMissingDishSales)
        console.log('[push] order', order.id, 'existing:', existingOrder?.status ?? 'null', 'shouldFinalize:', shouldFinalizePaidOrder, 'missingDishSales:', existingMissingDishSales, 'billingUser:', context.billingUserId)
        const persistedStatus = shouldFinalizePaidOrder ? 'PENDING' : order.status

        await tx.restaurantOrder.upsert({
          where: { id: order.id },
          create: {
            id: order.id,
            restaurantId: order.restaurant_id,
            branchId: resolvedBranchId,
            tableId: order.table_id,
            tableName: order.table_name,
            orderNumber: order.order_number,
            status: persistedStatus as any,
            paymentMethod: shouldFinalizePaidOrder ? null : order.payment_method,
            subtotalAmount: order.subtotal_amount,
            vatAmount: order.vat_amount,
            totalAmount: order.total_amount,
            createdById: claims.sub,
            createdByName: order.created_by_name ?? '',
            servedAt: order.served_at ? new Date(order.served_at) : null,
            paidAt: shouldFinalizePaidOrder ? null : (order.paid_at ? new Date(order.paid_at) : null),
            canceledAt: shouldFinalizePaidOrder ? null : (order.canceled_at ? new Date(order.canceled_at) : null),
            cancelReason: shouldFinalizePaidOrder ? null : order.cancel_reason,
            createdAt: new Date(order.created_at),
            updatedAt: new Date(order.updated_at),
          },
          update: {
            status: persistedStatus as any,
            paymentMethod: shouldFinalizePaidOrder ? null : order.payment_method,
            subtotalAmount: order.subtotal_amount,
            vatAmount: order.vat_amount,
            totalAmount: order.total_amount,
            servedAt: order.served_at ? new Date(order.served_at) : null,
            paidAt: shouldFinalizePaidOrder ? null : (order.paid_at ? new Date(order.paid_at) : null),
            canceledAt: shouldFinalizePaidOrder ? null : (order.canceled_at ? new Date(order.canceled_at) : null),
            cancelReason: shouldFinalizePaidOrder ? null : order.cancel_reason,
            updatedAt: new Date(order.updated_at),
          },
        })

        for (const item of items) {
          await tx.restaurantOrderItem.upsert({
            where: { id: item.id },
            create: {
              id: item.id,
              orderId: item.order_id,
              dishId: item.dish_id,
              dishName: item.dish_name,
              dishPrice: item.dish_price,
              qty: item.qty,
              status: item.status as any,
              createdAt: new Date(item.created_at),
              updatedAt: new Date(item.updated_at),
            },
            update: {
              qty: item.qty,
              status: item.status as any,
              updatedAt: new Date(item.updated_at),
            },
          })
        }

        if (shouldFinalizePaidOrder) {
          if (!resolvedBranchId) {
            throw new Error('Paid order sync requires branch assignment')
          }

          await finalizeRestaurantOrderPayment(tx, {
            billingUserId: context.billingUserId,
            restaurantId: order.restaurant_id,
            branchId: resolvedBranchId,
            includeBranchlessRows,
            sourceDeviceId: mobileSourceDeviceId,
            orderId: order.id,
            paidById: claims.sub,
            paidByName: context.currentUser.name ?? order.created_by_name ?? null,
            paymentMethod: order.payment_method,
            paidAt: order.paid_at ? new Date(order.paid_at) : undefined,
          })

          return
        }

        try {
          await enqueueOrderSync(tx, order.id, order.restaurant_id, resolvedBranchId, mobileSourceDeviceId)
        } catch {
          // Non-fatal — order is already in Neon, sync queue failure doesn't block the response
        }
      }, { timeout: 30000 })

      syncedOrderIds.push(order.id)
    }

    return jsonNoStore({ ok: true, syncedOrderIds })
  } catch (err: any) {
    if (err.message === 'Unauthorized') {
      return jsonNoStore({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('[mobile/push]', err)
    return jsonNoStore({ error: 'Server error' }, { status: 500 })
  }
}
