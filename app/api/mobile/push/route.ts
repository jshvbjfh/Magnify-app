import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { jwtVerify } from 'jose'
import { enqueueOrderSync } from '@/lib/restaurantOrders'
import { finalizeRestaurantOrderPayment } from '@/lib/restaurantOrderPayment'
import { resolveActiveStaffAccess } from '@/lib/mobileStaffAccess'

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

// A discount only counts when it is a real percentage inside 0-100. Anything
// else — absent, null, NaN, negative, over 100 — stores null, which every money
// path reads as "no discount". A device must not be able to invent revenue, or
// take a bill below zero, by pushing a malformed number.
function normalizeDiscountPercent(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) return null
  return parsed
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
  // Covers seated at the table. Optional — waiters may skip it, and clients
  // older than this field omit it entirely. Null means "not recorded".
  guest_count?: number | null
  paid_at: string | null
  canceled_at: string | null
  cancel_reason: string | null
  // Credit (A/R) settlement: who owes for this tab. Both optional — only a
  // Credit payment carries them, and the phone is optional even then.
  ar_customer_name?: string | null
  ar_customer_phone?: string | null
  // Service session this order was rung up in, and the business day it belongs
  // to (from that shift). Both optional — orders taken with no open shift, and
  // orders from app versions before shifts existed, simply carry neither.
  shift_id?: string | null
  business_date?: string | null
  // Which waiter app took the order: 'tablet' or 'desktop'. Optional — clients
  // older than this field omit it, and those orders stay null, which the till
  // reads as "not from a tablet". Anything unrecognised is discarded rather
  // than stored, so a stray value can never make the till offer a Push button
  // for an order that already printed.
  source?: string | null
  created_at: string
  updated_at: string
}

interface MobileShift {
  id: string
  restaurant_id: string
  business_date: string
  status: string
  opened_at: string
  opened_by_name?: string | null
  opened_by_staff_id?: string | null
  closed_at?: string | null
  closed_by_name?: string | null
  closed_by_staff_id?: string | null
  source_device_id?: string | null
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
  notes?: string | null
  branch_id?: string | null
  // Per-line discount, 0-100, set at the till against a supervisor PIN.
  discount_percent?: number | null
  created_at: string
  updated_at: string
}

/** POST /api/mobile/push — accepts orders from the waiter app and writes to Neon */
export async function POST(req: Request) {
  try {
    const claims = await verifyToken(req)
    const mobileSourceDeviceId = `mobile:${claims.sub}`

    // Use the staff record's CURRENT binding, never the JWT's point-in-time
    // claims: deactivated or reassigned staff must lose access immediately.
    const staffAccess = await resolveActiveStaffAccess(claims.sub)
    if (!staffAccess) {
      return jsonNoStore({ error: 'Unauthorized' }, { status: 401 })
    }

    const restaurantId = staffAccess.restaurantId
    const branchId = staffAccess.branchId

    const { orders, orderItems, shifts } = (await req.json()) as {
      orders: MobileOrder[]
      orderItems: MobileOrderItem[]
      shifts?: MobileShift[]
    }

    // Shifts must be upserted BEFORE orders: an order carries a shiftId FK, so
    // the shift row has to exist before the order that references it in the same
    // batch. Failing a single shift must never block orders, so each is guarded.
    const syncedShiftIds: string[] = []
    if (Array.isArray(shifts) && shifts.length > 0) {
      for (const shift of shifts) {
        if (shift.restaurant_id !== restaurantId) continue
        try {
          const businessDate = parseOptionalDate(shift.business_date)
          if (!businessDate) continue
          const openedAt = parseRequiredDate(shift.opened_at, new Date())
          const status = shift.status === 'CLOSED' ? 'CLOSED' : 'OPEN'
          await prisma.shift.upsert({
            where: { id: shift.id },
            create: {
              id: shift.id,
              restaurantId,
              businessDate,
              status,
              openedAt,
              openedByName: shift.opened_by_name ?? null,
              openedByStaffId: shift.opened_by_staff_id ?? null,
              closedAt: parseOptionalDate(shift.closed_at),
              closedByName: shift.closed_by_name ?? null,
              closedByStaffId: shift.closed_by_staff_id ?? null,
              sourceDeviceId: shift.source_device_id ?? mobileSourceDeviceId,
              createdAt: parseRequiredDate(shift.created_at, openedAt),
              updatedAt: parseRequiredDate(shift.updated_at, openedAt),
            },
            update: {
              // A shift only ever moves OPEN → CLOSED; never reopen a closed one
              // from a stale device that still thinks it's open.
              status,
              closedAt: parseOptionalDate(shift.closed_at),
              closedByName: shift.closed_by_name ?? null,
              closedByStaffId: shift.closed_by_staff_id ?? null,
              updatedAt: parseRequiredDate(shift.updated_at, openedAt),
            },
          })
          syncedShiftIds.push(shift.id)
        } catch (shiftErr) {
          console.error('[mobile/push] failed to upsert shift', { shiftId: shift.id, error: shiftErr instanceof Error ? shiftErr.message : String(shiftErr) })
        }
      }
    }

    if (!Array.isArray(orders) || !orders.length) {
      return jsonNoStore({ ok: true, syncedOrderIds: [], syncedShiftIds })
    }

    const syncedOrderIds: string[] = []
    const failedOrders: Array<{ orderId: string; error: string }> = []

    // Pre-fetch all valid branch IDs for this restaurant once, outside the order loop.
    const validBranchIds = new Set(
      (await prisma.branch.findMany({
        where: { restaurantId, isActive: true },
        select: { id: true },
      })).map((b) => b.id),
    )

    // Valid shift IDs for this restaurant — an order's shiftId is nulled if the
    // shift isn't on the server (e.g. its push failed), so a missing shift never
    // trips the FK and traps the order in a retry loop.
    const validShiftIds = new Set(
      (await prisma.shift.findMany({
        where: { restaurantId },
        select: { id: true },
      })).map((s) => s.id),
    )

    for (const order of orders) {
      if (order.restaurant_id !== restaurantId) continue

      // Use the order's own branch_id if it's a valid branch for this restaurant
      // (covers branch-switching: waiter switches branch → new orders store new branch_id locally).
      // Fall back to the JWT branchId only when the order carries no valid branch.
      const resolvedBranchId =
        order.branch_id && validBranchIds.has(order.branch_id)
          ? order.branch_id
          : branchId

      // Only trust the order's shiftId if that shift exists for this restaurant.
      // businessDate carries regardless (no FK) — it's the denormalized day the
      // device stamped at order-creation time.
      const resolvedShiftId =
        order.shift_id && validShiftIds.has(order.shift_id) ? order.shift_id : null
      const normalizedBusinessDate = parseOptionalDate(order.business_date)

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
      // Covers: keep null when absent or nonsensical rather than coercing to 0,
      // so a table with no recorded count is excluded from average-per-cover
      // instead of dragging it down as a zero-guest sale.
      const rawGuestCount = Number(order.guest_count)
      const normalizedGuestCount =
        Number.isInteger(rawGuestCount) && rawGuestCount > 0 ? rawGuestCount : null

      // Only these two values mean anything. Anything else is dropped rather
      // than stored, so a stray string can never make the till offer to push
      // tickets for an order whose slips already printed.
      const normalizedSource =
        order.source === 'tablet' || order.source === 'desktop' ? order.source : null

      let needsPostTxEnqueue = false

      try {
        await prisma.$transaction(async (tx) => {
          const existingOrder = await tx.restaurantOrder.findFirst({
            where: { id: order.id, restaurantId },
            select: { status: true },
          })

          // Fast path: order already fully processed — skip all heavy work
          if (order.status === 'PAID' && existingOrder?.status === 'PAID') {
            const hasDishSales = await tx.dishSale.count({ where: { orderId: order.id } }) > 0
            if (hasDishSales) {
              needsPostTxEnqueue = false
              return
            }
          }

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
              branchId: resolvedBranchId,
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
              guestCount: normalizedGuestCount,
              shiftId: resolvedShiftId,
              businessDate: normalizedBusinessDate,
              source: normalizedSource,
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
              // Keep createdByName in sync so attribution changes (e.g. a waiter
              // confirming a guest QR order) propagate to the cloud and kitchen.
              createdByName: normalizedCreatedByName,
              // Same rule as shift/day below — only ever set a count, never
              // clear one the server already holds. An older client that omits
              // the field must not wipe a number a waiter already entered.
              ...(normalizedGuestCount !== null ? { guestCount: normalizedGuestCount } : {}),
              status: persistedStatus,
              paymentMethod: shouldFinalizePaidOrder ? null : order.payment_method,
              subtotalAmount: normalizedSubtotalAmount,
              vatAmount: normalizedVatAmount,
              totalAmount: normalizedTotalAmount,
              // Stamp the shift/day if the order didn't already carry one — but
              // never clear a value the server already has (a re-sync from an old
              // client that omits these must not wipe attribution).
              ...(resolvedShiftId ? { shiftId: resolvedShiftId } : {}),
              ...(normalizedBusinessDate ? { businessDate: normalizedBusinessDate } : {}),
              // Same rule: set it if we were told, never clear what is already
              // stored. A re-sync from a client too old to send it must not
              // erase the origin of an order the till still has to push.
              ...(normalizedSource ? { source: normalizedSource } : {}),
              paidAt: shouldFinalizePaidOrder ? null : normalizedPaidAt,
              canceledAt: shouldFinalizePaidOrder ? null : normalizedCanceledAt,
              cancelReason: shouldFinalizePaidOrder ? null : order.cancel_reason,
              updatedAt: normalizedUpdatedAt,
            },
          })

          for (const item of items) {
            const normalizedItemCreatedAt = parseRequiredDate(item.created_at, normalizedCreatedAt)
            const normalizedItemUpdatedAt = parseRequiredDate(item.updated_at, normalizedItemCreatedAt)

            // No FK on OrderItem.branchId — it's an attribution hint only, so it's the
            // one place client input needs an explicit guard before trusting it.
            const resolvedItemBranchId =
              item.branch_id && validBranchIds.has(item.branch_id) ? item.branch_id : null

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
                notes: item.notes ?? null,
                // Immutable once stamped — the station snapshot from when the item
                // was rung up must never drift on update (matches how nothing else
                // touches it either).
                branchId: resolvedItemBranchId,
                discountPercent: normalizeDiscountPercent(item.discount_percent),
                createdAt: normalizedItemCreatedAt,
                updatedAt: normalizedItemUpdatedAt,
              },
              update: {
                dishName: normalizeRequiredText(item.dish_name, `Dish ${item.dish_id}`),
                dishPrice: normalizeNumber(item.dish_price),
                qty: Math.max(1, normalizeInteger(item.qty, 1)),
                status: normalizeRequiredText(item.status, 'ACTIVE'),
                notes: item.notes ?? null,
                discountPercent: normalizeDiscountPercent(item.discount_percent),
                updatedAt: normalizedItemUpdatedAt,
              },
            })
          }

          if (shouldFinalizePaidOrder) {
            await finalizeRestaurantOrderPayment(tx, {
              restaurantId,
              branchId: resolvedBranchId,
              sourceDeviceId: mobileSourceDeviceId,
              orderId: order.id,
              paymentMethod: order.payment_method,
              // Only meaningful on a Credit settlement; the finalizer ignores
              // blanks, so a normal cash order passes nulls harmlessly.
              arCustomerName: order.ar_customer_name?.trim() || null,
              arCustomerPhone: order.ar_customer_phone?.trim() || null,
              paidAt: normalizedPaidAt ?? undefined,
            })
            return
          }

          needsPostTxEnqueue = true
        }, { timeout: 8000 })

        if (needsPostTxEnqueue) {
          try {
            await enqueueOrderSync(prisma, order.id, restaurantId, resolvedBranchId, mobileSourceDeviceId)
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
      syncedShiftIds,
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
