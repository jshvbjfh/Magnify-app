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

function normalizeRequiredText(value: string | null | undefined, fallback: string) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed || fallback
}

function parseOptionalDate(value: string | null | undefined) {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function parseRequiredDate(value: string | null | undefined, fallback: Date) {
  return parseOptionalDate(value) ?? fallback
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

    // Auto-resolve branchId for single-branch restaurants where the waiter JWT has no
    // branch assignment. If branchId cannot be resolved, reject the entire push —
    // every order (PENDING, PAID, CANCELLED, CONFIRMED) must carry a branchId for
    // revenue attribution, reporting, and inventory correctness.
    let effectiveBranchId: string | null = branchId ?? null
    if (!effectiveBranchId) {
      const activeBranches = await prisma.restaurantBranch.findMany({
        where: { restaurantId, isActive: true },
        select: { id: true },
        take: 2, // only need to know if there is exactly one
      })
      if (activeBranches.length === 1) {
        effectiveBranchId = activeBranches[0].id
      }
    }

    if (!effectiveBranchId) {
      return jsonNoStore(
        { error: 'Waiter is not assigned to a branch. Ask your manager to assign you to a branch before syncing orders.' },
        { status: 400 },
      )
    }

    const includeBranchlessRows = true // effectiveBranchId is guaranteed non-null here

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
      // Security: ensure the order belongs to the authenticated restaurant
      if (order.restaurant_id !== restaurantId) continue

      // Security: reject orders claiming a branch the waiter is not assigned to.
      // The JWT branchId is the authoritative value — never trust the client payload.
      if (branchId && order.branch_id && order.branch_id !== branchId) continue

      const items = orderItems.filter(i => i.order_id === order.id)

      // Always stamp with the JWT-verified branchId and createdById.
      // createdById is a non-nullable column; the waiter's user ID is in claims.sub.
      const resolvedBranchId = effectiveBranchId
      const normalizedOrderNumber = normalizeRequiredText(order.order_number, buildFallbackOrderNumber(order.id))
      const normalizedTableName = normalizeRequiredText(order.table_name, order.table_id ? 'Table' : 'Takeaway')
      const normalizedCreatedByName = normalizeRequiredText(order.created_by_name, context.currentUser.name ?? 'Waiter')
      const normalizedCreatedAt = parseRequiredDate(order.created_at, new Date())
      const normalizedUpdatedAt = parseRequiredDate(order.updated_at, normalizedCreatedAt)
      const normalizedServedAt = parseOptionalDate(order.served_at)
      const normalizedPaidAt = parseOptionalDate(order.paid_at)
      const normalizedCanceledAt = parseOptionalDate(order.canceled_at)
      const normalizedSubtotalAmount = normalizeNumber(order.subtotal_amount)
      const normalizedVatAmount = normalizeNumber(order.vat_amount)
      const normalizedTotalAmount = normalizeNumber(order.total_amount)

      if (!String(order.order_number ?? '').trim() || !String(order.table_name ?? '').trim()) {
        console.warn('[mobile/push] normalizing legacy order fields', {
          orderId: order.id,
          hadOrderNumber: Boolean(String(order.order_number ?? '').trim()),
          hadTableName: Boolean(String(order.table_name ?? '').trim()),
        })
      }

      // Track whether enqueueOrderSync should run after the transaction commits.
      // It is intentionally moved OUTSIDE the transaction so it uses the main
      // prisma client and is guaranteed to find the committed order via findUnique.
      // Running it inside $transaction with the tx client caused silent failures on
      // some Prisma/PG versions where read-your-own-writes is not visible until commit.
      let needsPostTxEnqueue = false

      try {
        await prisma.$transaction(async (tx) => {
          const existingOrder = await tx.restaurantOrder.findFirst({
            where: { id: order.id, restaurantId: order.restaurant_id },
            select: { status: true },
          })

          // If the existing order is already PAID but has no dish sales (e.g. a
          // previous transaction timed out after committing the status update but
          // before recording sales), we still need to finalize so dish sales and
          // inventory deductions are created. recordDishSalesForPaidOrder is
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
              tableName: normalizedTableName,
              orderNumber: normalizedOrderNumber,
              status: persistedStatus as any,
              paymentMethod: shouldFinalizePaidOrder ? null : order.payment_method,
              subtotalAmount: normalizedSubtotalAmount,
              vatAmount: normalizedVatAmount,
              totalAmount: normalizedTotalAmount,
              createdById: claims.sub,
              createdByName: normalizedCreatedByName,
              servedAt: normalizedServedAt,
              paidAt: shouldFinalizePaidOrder ? null : normalizedPaidAt,
              canceledAt: shouldFinalizePaidOrder ? null : normalizedCanceledAt,
              cancelReason: shouldFinalizePaidOrder ? null : order.cancel_reason,
              createdAt: normalizedCreatedAt,
              updatedAt: normalizedUpdatedAt,
            },
            update: {
              branchId: resolvedBranchId,
              tableId: order.table_id,
              tableName: normalizedTableName,
              orderNumber: normalizedOrderNumber,
              status: persistedStatus as any,
              paymentMethod: shouldFinalizePaidOrder ? null : order.payment_method,
              subtotalAmount: normalizedSubtotalAmount,
              vatAmount: normalizedVatAmount,
              totalAmount: normalizedTotalAmount,
              servedAt: normalizedServedAt,
              paidAt: shouldFinalizePaidOrder ? null : normalizedPaidAt,
              canceledAt: shouldFinalizePaidOrder ? null : normalizedCanceledAt,
              cancelReason: shouldFinalizePaidOrder ? null : order.cancel_reason,
              updatedAt: normalizedUpdatedAt,
            },
          })

          for (const item of items) {
            const normalizedItemCreatedAt = parseRequiredDate(item.created_at, normalizedCreatedAt)
            const normalizedItemUpdatedAt = parseRequiredDate(item.updated_at, normalizedItemCreatedAt)

            await tx.restaurantOrderItem.upsert({
              where: { id: item.id },
              create: {
                id: item.id,
                orderId: item.order_id,
                dishId: item.dish_id,
                dishName: normalizeRequiredText(item.dish_name, `Dish ${item.dish_id}`),
                dishPrice: normalizeNumber(item.dish_price),
                qty: Math.max(1, normalizeInteger(item.qty, 1)),
                status: normalizeRequiredText(item.status, 'ACTIVE') as any,
                createdAt: normalizedItemCreatedAt,
                updatedAt: normalizedItemUpdatedAt,
              },
              update: {
                dishName: normalizeRequiredText(item.dish_name, `Dish ${item.dish_id}`),
                dishPrice: normalizeNumber(item.dish_price),
                qty: Math.max(1, normalizeInteger(item.qty, 1)),
                status: normalizeRequiredText(item.status, 'ACTIVE') as any,
                updatedAt: normalizedItemUpdatedAt,
              },
            })
          }

          if (shouldFinalizePaidOrder) {
            // resolvedBranchId is guaranteed non-null — hard-rejected at request entry if missing
            await finalizeRestaurantOrderPayment(tx, {
              billingUserId: context.billingUserId,
              restaurantId: order.restaurant_id,
              branchId: resolvedBranchId,
              includeBranchlessRows,
              sourceDeviceId: mobileSourceDeviceId,
              orderId: order.id,
              paidById: claims.sub,
              paidByName: context.currentUser.name ?? normalizedCreatedByName,
              paymentMethod: order.payment_method,
              paidAt: normalizedPaidAt ?? undefined,
            })

            // finalizeRestaurantOrderPayment calls enqueueOrderSync internally
            return
          }

          // Flag for post-transaction enqueue (see comment above needsPostTxEnqueue)
          needsPostTxEnqueue = true
        }, { timeout: 30000 })

        // Enqueue AFTER the transaction commits so prisma (main client) can
        // reliably find the committed order row via findUnique.
        if (needsPostTxEnqueue) {
          try {
            await enqueueOrderSync(prisma, order.id, order.restaurant_id, resolvedBranchId, mobileSourceDeviceId)
          } catch (enqueueErr) {
            // Non-fatal — order is in Neon but won't appear in next sync batch.
            // Log so the failure is visible in server logs / Vercel function logs.
            console.error('[mobile/push] enqueueOrderSync failed for order', order.id, enqueueErr)
          }
        }

        syncedOrderIds.push(order.id)
      } catch (orderErr) {
        const errorMessage = orderErr instanceof Error ? orderErr.message : String(orderErr)
        failedOrders.push({ orderId: order.id, error: errorMessage })
        console.error('[mobile/push] failed to process order', {
          orderId: order.id,
          status: order.status,
          error: errorMessage,
        })
      }
    }

    return jsonNoStore({
      ok: failedOrders.length === 0,
      syncedOrderIds,
      failedOrderIds: failedOrders.map(entry => entry.orderId),
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
