import { Prisma, type PrismaClient } from '@prisma/client'
import { calculateGrossFromNet, calculateVatFromNet } from '@/lib/restaurantVat'
import { enqueueSyncChange } from '@/lib/syncOutbox'

type PrismaDb = PrismaClient | Prisma.TransactionClient

type TotalsInput = Array<{ dishPrice: number; qty: number; discountPercent?: number | null }>

export const ACTIVE_RESTAURANT_ORDER_STATUSES = ['PENDING', 'OPEN'] as const

/**
 * The tender written on a comped bill: the guests ate, the table closed, and
 * nothing was collected — the owner's guests, a staff meal, a service recovery.
 *
 * It is a settlement, not a payment. An order carrying it is stored with its
 * totals at zero and the written-off value kept in `compedAmount`, so revenue,
 * average-per-cover and every sales report contribute nothing for it without
 * having to know comps exist. The food still comes off stock, because it really
 * was cooked and eaten.
 *
 * Exported as one constant rather than spelled out at each call site: the string
 * is compared in the push handler, the payment finalizer and the reports, and a
 * typo in any one of them would silently book a comp as income.
 */
export const NO_CHARGE_METHOD = 'compl.'

/**
 * Every spelling this tender has ever been stored under.
 *
 * 'No Charge' shipped first and is hardcoded into the tills already in the
 * field, which keep sending it until every one of them updates. Dropping it
 * here would not "clean up a legacy name" — it would make those comps stop
 * being recognised as comps, and a comp that is not recognised is booked as
 * revenue that was never collected. Never remove a value from this list.
 */
const NO_CHARGE_ALIASES = [NO_CHARGE_METHOD, 'No Charge', 'compl', 'complimentary']
  .map((value) => value.toLowerCase())

/** Whether a settlement collected nothing. Trims and ignores case, because the
 *  value arrives from a device and only ever has to mean one thing. */
export function isNoChargeMethod(paymentMethod: string | null | undefined): boolean {
  return NO_CHARGE_ALIASES.includes(String(paymentMethod ?? '').trim().toLowerCase())
}

/** Every stored spelling, for `where: { paymentMethod: { in: ... } }` filters
 *  that cannot call isNoChargeMethod because the matching happens in SQL. */
export const NO_CHARGE_METHOD_VALUES = ['compl.', 'compl', 'complimentary', 'No Charge']

/**
 * What one line is actually worth after its discount — the ONLY definition of
 * that in the app, on purpose.
 *
 * Three separate places used to turn a line into money: the order totals below,
 * the journal entry raised at payment, and DishSale.totalSaleAmount. If any one
 * of them applied a discount the others did not, the till would collect one
 * figure and the books would record another, and nothing would surface it until
 * a reconciliation failed weeks later. They all call this now.
 *
 * A discount outside 0–100, or one that is not a finite number, is treated as no
 * discount at all. Refusing loudly would block a waiter mid-service over a
 * mistyped field; charging full price is the safe direction to fail, because it
 * is visible on the bill immediately and nobody is short-changed.
 */
export function calculateLineNetAmount(item: { dishPrice: number; qty: number; discountPercent?: number | null }) {
  const gross = Number(item.dishPrice) * Number(item.qty)
  if (!Number.isFinite(gross)) return 0
  const raw = Number(item.discountPercent)
  const pct = Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : 0
  return gross * (1 - pct / 100)
}

export function calculateRestaurantOrderTotals(items: TotalsInput) {
  const subtotalAmount = items.reduce((sum, item) => sum + calculateLineNetAmount(item), 0)
  const vatAmount = calculateVatFromNet(subtotalAmount)
  const totalAmount = calculateGrossFromNet(subtotalAmount)

  return { subtotalAmount, vatAmount, totalAmount }
}

export function getRestaurantOrderDisplayStatus(order: { status: string }) {
  if (order.status === 'CANCELED') return 'CANCELED'
  if (order.status === 'PAID') return 'PAID'
  return 'PENDING'
}

export async function generateRestaurantOrderNumber(db: PrismaDb, restaurantId: string, branchId?: string | null) {
  const latest = await db.restaurantOrder.findFirst({
    where: {
      restaurantId,
      ...(branchId ? { branchId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    select: { orderNumber: true },
  })

  const current = latest?.orderNumber ? Number(latest.orderNumber.replace(/[^0-9]/g, '')) || 0 : 0
  return `ORD-${String(current + 1).padStart(6, '0')}`
}

export function isRestaurantOrderNumberConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && error.code === 'P2002'
    && Array.isArray(error.meta?.target)
    && error.meta.target.includes('orderNumber')
    && (error.meta.target.includes('restaurantId') || error.meta.target.includes('branchId'))
}

export async function syncRestaurantOrderTotals(db: PrismaDb, orderId: string) {
  const activeItems = await db.orderItem.findMany({
    where: { orderId, status: 'ACTIVE' },
    select: { dishPrice: true, qty: true },
  })

  const totals = calculateRestaurantOrderTotals(activeItems)

  return db.restaurantOrder.update({
    where: { id: orderId },
    data: totals,
  })
}

export async function enqueueOrderSync(
  db: PrismaDb,
  orderId: string,
  restaurantId: string,
  branchId?: string | null,
  sourceDeviceId?: string | null,
) {
  const order = await db.restaurantOrder.findUnique({
    where: { id: orderId },
    include: { items: true },
  })
  if (!order) return

  if (order.items.length === 0 && order.status !== 'CANCELED') {
    console.warn(`[sync] enqueueOrderSync: order ${orderId} has 0 items (status=${order.status})`)
  }

  await enqueueSyncChange(db, {
    restaurantId,
    branchId: branchId ?? order.branchId ?? null,
    entityType: 'restaurantOrder',
    entityId: orderId,
    operation: 'upsert',
    sourceDeviceId: sourceDeviceId ?? null,
    payload: { ...order, items: order.items },
  })
}

function formatTimelineEventAt(value: Date | string | null) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return null

  return new Intl.DateTimeFormat('en-RW', {
    timeZone: 'Africa/Kigali',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function buildRestaurantOrderTimeline(order: {
  createdAt: Date | string
  createdByName?: string | null
  paidAt: Date | string | null
  canceledAt: Date | string | null
  cancelReason: string | null
}) {
  const createdAtLabel = formatTimelineEventAt(order.createdAt)
  const timeline = [`Pushed by ${order.createdByName || 'Staff'}${createdAtLabel ? ` at ${createdAtLabel}` : ''}`]

  if (order.paidAt) {
    const paidAtLabel = formatTimelineEventAt(order.paidAt)
    timeline.push(`Paid${paidAtLabel ? ` at ${paidAtLabel}` : ''}`)
  }
  if (order.canceledAt) {
    const canceledAtLabel = formatTimelineEventAt(order.canceledAt)
    timeline.push(`Canceled${canceledAtLabel ? ` at ${canceledAtLabel}` : ''}${order.cancelReason ? ` - ${order.cancelReason}` : ''}`)
  }

  return timeline
}
