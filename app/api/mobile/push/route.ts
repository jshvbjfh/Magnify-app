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

    // Auto-resolve branchId for single-branch restaurants where the waiter JWT has no
    // branch assignment. Without this, PAID orders for unassigned waiters fail with
    // 'Paid order sync requires branch assignment' and roll back the entire transaction,
    // causing an infinite retry loop (order never saved to Neon).
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

    const includeBranchlessRows = Boolean(effectiveBranchId)

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
      const resolvedBranchId = effectiveBranchId

      // Track whether enqueueOrderSync should run after the transaction commits.
      // It is intentionally moved OUTSIDE the transaction so it uses the main
      // prisma client and is guaranteed to find the committed order via findUnique.
      // Running it inside $transaction with the tx client caused silent failures on
      // some Prisma/PG versions where read-your-own-writes is not visible until commit.
      let needsPostTxEnqueue = false

      await prisma.$transaction(async (tx) => {
        const existingOrder = await tx.restaurantOrder.findFirst({
          where: { id: order.id, restaurantId: order.restaurant_id },
          select: { status: true },
        })

        // Guard: only count missing dish sales when we have a resolvable branchId.
        // Without this guard, PAID orders with no branch would trigger existingMissingDishSales=true
        // on every subsequent push, creating an infinite re-finalization retry loop.
        const existingMissingDishSales =
          order.status === 'PAID' && existingOrder?.status === 'PAID' && Boolean(resolvedBranchId)
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
            // No resolvable branch (multi-branch restaurant, waiter not assigned).
            // Save the order as PAID without DishSale finalization so the order is
            // preserved in Neon and the retry loop is broken (existingMissingDishSales
            // is gated on resolvedBranchId above, so this path is only hit once).
            console.warn('[push] PAID order', order.id, 'restaurant', restaurantId, '— no resolvable branchId, saving without finalization')
            await tx.restaurantOrder.updateMany({
              where: { id: order.id },
              data: {
                status: 'PAID',
                paymentMethod: order.payment_method,
                paidAt: order.paid_at ? new Date(order.paid_at) : new Date(),
                paidById: claims.sub,
                paidByName: context.currentUser.name ?? order.created_by_name ?? null,
              },
            })
            needsPostTxEnqueue = true
            return
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
