/**
 * High 5ive (2026-07-14): cancel three test orders stuck in Pending
 * (WA-5D1E7794, WA-E8DCBBC6, WA-B400BE31). Mirrors the app's cancel flow:
 * items → CANCELED, order → CANCELED, table freed, and sync-outbox rows so
 * waiter apps pull the change.
 */
import { createRequire } from 'module'
import { resolve } from 'path'
import { readFileSync } from 'fs'
import { randomUUID } from 'crypto'
for (const file of ['.env.local', '.env']) {
  try {
    for (const line of readFileSync(resolve(process.cwd(), file), 'utf8').split('\n')) {
      const t = line.trim(); if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('='); if (eq < 0) continue
      const k = t.slice(0, eq).trim(), v = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
      if (!process.env[k]) process.env[k] = v
    }
  } catch {}
}
const require = createRequire(import.meta.url)
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })

const ORDER_NUMBERS = ['WA-5D1E7794', 'WA-E8DCBBC6', 'WA-B400BE31']
const REASON = 'Test order removed by owner'

const user = await prisma.user.findUnique({ where: { email: 'high5ive@management.com' }, select: { id: true } })
const rest = await prisma.restaurant.findFirst({ where: { ownerId: user.id }, select: { id: true } })

const outbox = (branchId, entityType, entityId, payload) => prisma.syncOutbox.create({
  data: {
    scopeId: rest.id, restaurantId: rest.id, branchId: branchId ?? null,
    entityType, entityId, operation: 'upsert',
    payload: JSON.stringify(payload),
    mutationId: randomUUID(), sourceDeviceId: 'cloud', availableAt: new Date(),
  },
})

for (const orderNumber of ORDER_NUMBERS) {
  const order = await prisma.restaurantOrder.findFirst({
    where: { restaurantId: rest.id, orderNumber, deletedAt: null },
    select: { id: true, status: true, branchId: true, tableId: true },
  })
  if (!order) { console.log(`${orderNumber}: not found — skipped`); continue }
  if (order.status === 'CANCELED') { console.log(`${orderNumber}: already canceled — skipped`); continue }

  await prisma.$transaction(async tx => {
    const now = new Date()
    await tx.orderItem.updateMany({
      where: { orderId: order.id, status: 'ACTIVE' },
      data: { status: 'CANCELED', cancelReason: REASON, canceledAt: now },
    })
    await tx.restaurantOrder.update({
      where: { id: order.id },
      data: { status: 'CANCELED', canceledAt: now, cancelReason: REASON },
    })
    if (order.tableId) {
      await tx.restaurantTable.updateMany({
        where: { id: order.tableId, restaurantId: rest.id },
        data: { status: 'available' },
      })
    }
  }, { timeout: 30000 })

  // Outbox rows (same shape as enqueueOrderSync / enqueueRestaurantTableSync)
  const fullOrder = await prisma.restaurantOrder.findUnique({ where: { id: order.id }, include: { items: true } })
  await outbox(fullOrder.branchId, 'restaurantOrder', fullOrder.id, fullOrder)
  if (order.tableId) {
    const table = await prisma.restaurantTable.findUnique({ where: { id: order.tableId } })
    if (table) await outbox(table.branchId ?? null, 'restaurantTable', table.id, table)
  }
  console.log(`${orderNumber}: canceled (${fullOrder.items.length} items)${order.tableId ? ', table freed' : ''}`)
}

await prisma.$disconnect()
console.log('Done.')
