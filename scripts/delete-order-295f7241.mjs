/**
 * Owner-confirmed: order WA-295F7241 (Little Taipei, table TM-5, 28,000 RWF,
 * still PENDING/unpaid, zero dish sales, zero journal entries) was a mistake.
 * Hard-delete — not cancel — so it leaves no trace in history or reports.
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

const ORDER_ID = 'b1627492-98df-4b95-bbc1-1d53295f7241'

const order = await prisma.restaurantOrder.findUnique({ where: { id: ORDER_ID }, select: { branchId: true, restaurantId: true, tableId: true, status: true, paidAt: true } })
if (!order) throw new Error('Order not found — already deleted?')
if (order.status !== 'PENDING' || order.paidAt) throw new Error(`Refusing to hard-delete: status=${order.status} paidAt=${order.paidAt}`)

await prisma.$transaction(async tx => {
  await tx.orderItem.deleteMany({ where: { orderId: ORDER_ID } })
  await tx.restaurantOrder.delete({ where: { id: ORDER_ID } })

  // Drop the earlier upsert outbox rows and broadcast a delete so devices
  // that already pulled this order remove it instead of re-creating it.
  await tx.syncOutbox.deleteMany({ where: { entityType: 'restaurantOrder', entityId: ORDER_ID } })
  await tx.syncOutbox.create({
    data: {
      scopeId: order.restaurantId, restaurantId: order.restaurantId, branchId: order.branchId,
      entityType: 'restaurantOrder', entityId: ORDER_ID, operation: 'delete',
      payload: JSON.stringify({ id: ORDER_ID }),
      mutationId: randomUUID(), sourceDeviceId: 'cloud', availableAt: new Date(),
    },
  })

  // Free the table if this order was the reason it was occupied.
  if (order.tableId) {
    await tx.restaurantTable.updateMany({
      where: { id: order.tableId, restaurantId: order.restaurantId },
      data: { status: 'available' },
    })
    await tx.syncOutbox.create({
      data: {
        scopeId: order.restaurantId, restaurantId: order.restaurantId, branchId: order.branchId,
        entityType: 'restaurantTable', entityId: order.tableId, operation: 'upsert',
        payload: JSON.stringify(await tx.restaurantTable.findUnique({ where: { id: order.tableId } })),
        mutationId: randomUUID(), sourceDeviceId: 'cloud', availableAt: new Date(),
      },
    })
  }
})

console.log('WA-295F7241 deleted from existence (order + items + outbox), table freed if applicable.')
await prisma.$disconnect()
