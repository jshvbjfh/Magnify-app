/**
 * High 5ive: the three test orders (already canceled earlier today) were never
 * real — remove them from existence entirely (order + items + earlier outbox
 * rows), and enqueue sync 'delete' ops so waiter devices drop them as well.
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

const user = await prisma.user.findUnique({ where: { email: 'high5ive@management.com' }, select: { id: true } })
const rest = await prisma.restaurant.findFirst({ where: { ownerId: user.id }, select: { id: true } })

for (const orderNumber of ORDER_NUMBERS) {
  const order = await prisma.restaurantOrder.findFirst({
    where: { restaurantId: rest.id, orderNumber },
    select: { id: true, branchId: true, _count: { select: { dishSales: true, items: true } } },
  })
  if (!order) { console.log(`${orderNumber}: not found — skipped`); continue }
  if (order._count.dishSales > 0) {
    console.log(`${orderNumber}: has ${order._count.dishSales} sale records — NOT deleted (would break sales history)`)
    continue
  }

  await prisma.$transaction(async tx => {
    await tx.orderItem.deleteMany({ where: { orderId: order.id } })
    await tx.restaurantOrder.delete({ where: { id: order.id } })
    // Drop the earlier cancel-upsert outbox rows so devices don't re-create it,
    // then broadcast a delete so devices that already have it remove it.
    await tx.syncOutbox.deleteMany({ where: { entityType: 'restaurantOrder', entityId: order.id } })
    await tx.syncOutbox.create({
      data: {
        scopeId: rest.id, restaurantId: rest.id, branchId: order.branchId,
        entityType: 'restaurantOrder', entityId: order.id, operation: 'delete',
        payload: JSON.stringify({ id: order.id }),
        mutationId: randomUUID(), sourceDeviceId: 'cloud', availableAt: new Date(),
      },
    })
  }, { timeout: 30000 })
  console.log(`${orderNumber}: deleted from existence (${order._count.items} items)`)
}

await prisma.$disconnect()
console.log('Done.')
