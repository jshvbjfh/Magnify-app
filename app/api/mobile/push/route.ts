import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { jwtVerify } from 'jose'
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
    headers: { ...NO_STORE_HEADERS, ...(init?.headers ?? {}) },
  })
}

function parseOptionalDate(value: string | null | undefined) {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function parseRequiredDate(value: string | null | undefined, fallback: Date) {
  return parseOptionalDate(value) ?? fallback
}

function normalizeRequiredText(value: string | null | undefined, fallback: string) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed || fallback
}

function normalizeNumber(value: unknown, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeInteger(value: unknown, fallback = 1) {
  const parsed = Math.trunc(Number(value))
  return Number.isFinite(parsed) ? parsed : fallback
}

function buildFallbackOrderNumber(orderId: string) {
  const suffix = String(orderId || '').replace(/-/g, '').slice(-8).toUpperCase()
  return `WA-${suffix || Date.now().toString(36).slice(-8).toUpperCase()}`
}

async function verifyToken(req: Request) {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) throw new Error('Unauthorized')
  const { payload } = await jwtVerify(token, SECRET)
  return payload as { sub: string; name?: string | null; restaurantId: string; branchId: string; role: string }
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

/** POST /api/mobile/push — accepts orders from the waiter app and writes to Neon */
export async function POST(req: Request) {
  try {
    const claims = await verifyToken(req)
    const { restaurantId, branchId } = claims
    const mobileSourceDeviceId = `mobile:${claims.sub}`

    if (!restaurantId || !branchId) {
      return jsonNoStore({ error: 'Unauthorized' }, { status: 401 })
    }

    const { orders, orderItems } = (await req.json()) as {
      orders: MobileOrder[]
      orderItems: MobileOrderItem[]
    }

    if (!Array.isArray(orders) || !orders.length) {
      return jsonNoStore({ ok: true, syncedOrderIds: [] })
    }

    const syncedOrderIds: string[] = []
    const failedOrders: Array<{ orderId: string; error: string }> = []

    for (const order of orders) {
      if (order.restaurant_id !== restaurantId) continue

      if (order.branch_id && order.branch_id !== branchId) {
        console.warn(
          '[mobile/push] Order %s has branch_id %s but staff %s is now on branch %s — overriding to server-side branch.',
          order.id, order.branch_id, claims.sub, branchId,
        )
      }

      const items = orderItems.filter((i) => i.order_id === order.id)
      const normalizedOrderNumber = normalizeRequiredText(order.order_number, buildFallbackOrderNumber(order.id))
      const normalizedTableName = normalizeRequiredText(order.table_name, order.table_id ? 'Table' : 'Takeaway')
      const normalizedCreatedByName = normalizeRequiredText(order.created_by_name, claims.name ?? 'Staff')
      const normalizedCreatedAt = parseRequiredDate(order.created_at, new Date())
      const normalizedUpdatedAt = parseRequiredDate(order.updated_at, normalizedCreatedAt)
      const normalizedPaidAt = parseOptionalDate(order.paid_at)
      const normalizedCanceledAt = parseOptionalDate(order.canceled_at)
      const normalizedSubtotalAmount = normalizeNumber(order.subtotal_amount)
      const normalizedVatAmount = normalizeNumber(order.vat_amount)
      const normalizedTotalAmount = normalizeNumber(order.total_amount)

      let needsPostTxEnqueue = false

      try {
        await prisma.$transaction(async (tx) => {
          const existingOrder = await tx.restaurantOrder.findFirst({
            where: { id: order.id, restaurantId },
            select: { status: true },
          })

          const existingMissingDishSales =
            order.status === 'PAID' && existingOrder?.status === 'PAID'
              ? (await tx.dishSale.count({ where: { orderId: order.id } })) === 0
              : false
          const shouldFinalizePaidOrder =
            order.status === 'PAID' && (existingOrder?.status !== 'PAID' || existingMissingDishSales)

          const persistedStatus = shouldFinalizePaidOrder ? 'PENDING' : order.status

          await tx.restaurantOrder.upsert({
            where: { id: order.id },
            create: {
              id: order.id,
              restaurantId,
              branchId,
              tableId: order.table_id,
              tableName: normalizedTableName,
              orderNumber: normalizedOrderNumber,
              status: persistedStatus,
              paymentMethod: shouldFinalizePaidOrder ? null : order.payment_method,
              subtotalAmount: normalizedSubtotalAmount,
              vatAmount: normalizedVatAmount,
              totalAmount: normalizedTotalAmount,
              staffId: claims.sub,
              createdByName: normalizedCreatedByName,
              paidAt: shouldFinalizePaidOrder ? null : normalizedPaidAt,
              canceledAt: shouldFinalizePaidOrder ? null : normalizedCanceledAt,
              cancelReason: shouldFinalizePaidOrder ? null : order.cancel_reason,
              createdAt: normalizedCreatedAt,
              updatedAt: normalizedUpdatedAt,
            },
            update: {
              branchId,
              tableId: order.table_id,
              tableName: normalizedTableName,
              orderNumber: normalizedOrderNumber,
              status: persistedStatus,
              paymentMethod: shouldFinalizePaidOrder ? null : order.payment_method,
              subtotalAmount: normalizedSubtotalAmount,
              vatAmount: normalizedVatAmount,
              totalAmount: normalizedTotalAmount,
              paidAt: shouldFinalizePaidOrder ? null : normalizedPaidAt,
              canceledAt: shouldFinalizePaidOrder ? null : normalizedCanceledAt,
              cancelReason: shouldFinalizePaidOrder ? null : order.cancel_reason,
              updatedAt: normalizedUpdatedAt,
            },
          })

          for (const item of items) {
            const normalizedItemCreatedAt = parseRequiredDate(item.created_at, normalizedCreatedAt)
            const normalizedItemUpdatedAt = parseRequiredDate(item.updated_at, normalizedItemCreatedAt)

            await tx.orderItem.upsert({
              where: { id: item.id },
              create: {
                id: item.id,
                orderId: item.order_id,
                dishId: item.dish_id,
                dishName: normalizeRequiredText(item.dish_name, `Dish ${item.dish_id}`),
                dishPrice: normalizeNumber(item.dish_price),
                qty: Math.max(1, normalizeInteger(item.qty, 1)),
                status: normalizeRequiredText(item.status, 'ACTIVE'),
                createdAt: normalizedItemCreatedAt,
                updatedAt: normalizedItemUpdatedAt,
              },
              update: {
                dishName: normalizeRequiredText(item.dish_name, `Dish ${item.dish_id}`),
                dishPrice: normalizeNumber(item.dish_price),
                qty: Math.max(1, normalizeInteger(item.qty, 1)),
                status: normalizeRequiredText(item.status, 'ACTIVE'),
                updatedAt: normalizedItemUpdatedAt,
              },
            })
          }

          if (shouldFinalizePaidOrder) {
            await finalizeRestaurantOrderPayment(tx, {
              restaurantId,
              branchId,
              sourceDeviceId: mobileSourceDeviceId,
              orderId: order.id,
              paymentMethod: order.payment_method,
              paidAt: normalizedPaidAt ?? undefined,
            })
            return
          }

          needsPostTxEnqueue = true
        }, { timeout: 30000 })

        if (needsPostTxEnqueue) {
          try {
            await enqueueOrderSync(prisma, order.id, restaurantId, branchId, mobileSourceDeviceId)
          } catch (enqueueErr) {
            console.error('[mobile/push] enqueueOrderSync failed for order', order.id, enqueueErr)
          }
        }

        syncedOrderIds.push(order.id)
      } catch (orderErr) {
        const errorMessage = orderErr instanceof Error ? orderErr.message : String(orderErr)
        failedOrders.push({ orderId: order.id, error: errorMessage })
        console.error('[mobile/push] failed to process order', { orderId: order.id, status: order.status, error: errorMessage })
      }
    }

    return jsonNoStore({
      ok: failedOrders.length === 0,
      syncedOrderIds,
      failedOrderIds: failedOrders.map((entry) => entry.orderId),
      failedOrders,
    })
  } catch (err: any) {
    if (err.message === 'Unauthorized') {
      return jsonNoStore({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('[mobile/push]', err)
    return jsonNoStore({ error: 'Server error' }, { status: 500 })
  }
}
