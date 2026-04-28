import { NextResponse } from 'next/server'
import prisma from '@/lib/prisma'
import { jwtVerify } from 'jose'
import { enqueueOrderSync } from '@/lib/restaurantOrders'

const SECRET = new TextEncoder().encode(
  process.env.NEXTAUTH_SECRET ?? 'fallback-secret-change-me'
)

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

    const { orders, orderItems } = (await req.json()) as {
      orders: MobileOrder[]
      orderItems: MobileOrderItem[]
    }

    if (!Array.isArray(orders) || !orders.length) {
      return NextResponse.json({ ok: true, syncedOrderIds: [] })
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

      await prisma.restaurantOrder.upsert({
        where: { id: order.id },
        create: {
          id: order.id,
          restaurantId: order.restaurant_id,
          branchId: resolvedBranchId,
          tableId: order.table_id,
          tableName: order.table_name,
          orderNumber: order.order_number,
          status: order.status as any,
          paymentMethod: order.payment_method,
          subtotalAmount: order.subtotal_amount,
          vatAmount: order.vat_amount,
          totalAmount: order.total_amount,
          createdById: claims.sub,
          createdByName: order.created_by_name ?? '',
          servedAt: order.served_at ? new Date(order.served_at) : null,
          paidAt: order.paid_at ? new Date(order.paid_at) : null,
          canceledAt: order.canceled_at ? new Date(order.canceled_at) : null,
          cancelReason: order.cancel_reason,
          createdAt: new Date(order.created_at),
          updatedAt: new Date(order.updated_at),
        },
        update: {
          status: order.status as any,
          paymentMethod: order.payment_method,
          subtotalAmount: order.subtotal_amount,
          vatAmount: order.vat_amount,
          totalAmount: order.total_amount,
          servedAt: order.served_at ? new Date(order.served_at) : null,
          paidAt: order.paid_at ? new Date(order.paid_at) : null,
          canceledAt: order.canceled_at ? new Date(order.canceled_at) : null,
          cancelReason: order.cancel_reason,
          updatedAt: new Date(order.updated_at),
        },
      })

      // Upsert order items
      for (const item of items) {
        await prisma.restaurantOrderItem.upsert({
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

      // Enqueue for manager Electron sync
      try {
        await enqueueOrderSync(prisma, order.id, order.restaurant_id, resolvedBranchId)
      } catch {
        // Non-fatal — order is already in Neon, sync queue failure doesn't block the response
      }

      syncedOrderIds.push(order.id)
    }

    return NextResponse.json({ ok: true, syncedOrderIds })
  } catch (err: any) {
    if (err.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('[mobile/push]', err)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
