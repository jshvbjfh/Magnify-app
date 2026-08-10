/** READ-ONLY: full state of order WA-295F7241 before deciding how to remove it. */
import { createRequire } from 'module'
import { resolve } from 'path'
import { readFileSync } from 'fs'
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

const order = await prisma.restaurantOrder.findFirst({
  where: { orderNumber: 'WA-295F7241' },
  include: {
    items: true,
    dishSales: true,
    table: { select: { name: true, id: true } },
    branch: { select: { name: true } },
  },
})
console.log(JSON.stringify(order, null, 2))

if (order) {
  const journal = await prisma.journalEntry.findMany({
    where: { restaurantId: order.restaurantId, description: { contains: order.id } },
  })
  console.log('\nJournal entries referencing this order id:', journal.length)

  const outbox = await prisma.syncOutbox.findMany({
    where: { entityType: 'restaurantOrder', entityId: order.id },
    select: { operation: true, sourceDeviceId: true, createdAt: true },
  })
  console.log('Outbox rows for this order:', JSON.stringify(outbox))
}

await prisma.$disconnect()
