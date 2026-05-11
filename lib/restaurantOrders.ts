import { Prisma, type PrismaClient } from '@prisma/client'
import { calculateGrossFromNet, calculateVatFromNet, RESTAURANT_VAT_RATE } from '@/lib/restaurantVat'
import { enqueueSyncChange } from '@/lib/syncOutbox'

type PrismaDb = PrismaClient | Prisma.TransactionClient

type TotalsInput = Array<{ dishPrice: number; qty: number }>

export function calculateRestaurantOrderTotals(items: TotalsInput) {
  const subtotalAmount = items.reduce((sum, item) => sum + Number(item.dishPrice) * Number(item.qty), 0)
  const vatAmount = calculateVatFromNet(subtotalAmount)
  const totalAmount = calculateGrossFromNet(subtotalAmount)

  return { subtotalAmount, vatAmount, totalAmount }
}

export function getRestaurantOrderDisplayStatus(order: { status: string; servedAt: Date | string | null }) {
  if (order.status === 'CANCELED') return 'CANCELED'
  if (order.status === 'PAID') return 'PAID'
  if (order.servedAt) return 'SERVED'
  return 'PENDING'
}

export async function generateRestaurantOrderNumber(db: PrismaDb, restaurantId: string, branchId?: string | null) {
  const latest = await db.restaurantOrder.findFirst({
    where: {
      restaurantId,
      ...(branchId !== undefined ? { branchId: branchId ?? null } : {}),
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
  const activeItems = await db.restaurantOrderItem.findMany({
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

  // Guard: log if order has no items — this indicates a recording issue upstream
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
    // items embedded in payload — syncEngine reads payload.items to recreate order items on cloud
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
  createdByName: string
  servedAt: Date | string | null
  servedByName: string | null
  paidAt: Date | string | null
  paidByName: string | null
  canceledAt: Date | string | null
  canceledByName: string | null
  cancelReason: string | null
}) {
  const createdAtLabel = formatTimelineEventAt(order.createdAt)
  const timeline = [`Pushed by ${order.createdByName || 'Staff'}${createdAtLabel ? ` at ${createdAtLabel}` : ''}`]

  if (order.servedAt) {
    const servedAtLabel = formatTimelineEventAt(order.servedAt)
    timeline.push(`Served by ${order.servedByName || 'Staff'}${servedAtLabel ? ` at ${servedAtLabel}` : ''}`)
  }
  if (order.paidAt) {
    const paidAtLabel = formatTimelineEventAt(order.paidAt)
    timeline.push(`Payment recorded by ${order.paidByName || 'Staff'}${paidAtLabel ? ` at ${paidAtLabel}` : ''}`)
  }
  if (order.canceledAt) {
    const canceledAtLabel = formatTimelineEventAt(order.canceledAt)
    timeline.push(`Canceled by ${order.canceledByName || 'Staff'}${canceledAtLabel ? ` at ${canceledAtLabel}` : ''}${order.cancelReason ? ` - ${order.cancelReason}` : ''}`)
  }

  return timeline
}