import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'

function readEnvVar(file, key) {
  const content = fs.readFileSync(file, 'utf8')
  const line = content.split('\n').find(l => l.startsWith(`${key}=`))
  if (!line) return null
  return line.slice(key.length + 1).trim().replace(/^"|"$/g, '')
}

const TARGET = ['WA-126872DB', 'WA-B348F7FB', 'WA-5CAA054C', 'WA-F3E86287']

const which = process.argv[2] || 'pg'
const url = which === 'pg' ? readEnvVar('.env.local', 'DATABASE_URL') : 'file:./prisma/dev.db'
const prisma = new PrismaClient({ datasources: { db: { url } } })

console.log(`=== ${which.toUpperCase()} ===`)

const orders = await prisma.restaurantOrder.findMany({
  where: { orderNumber: { in: TARGET } },
  include: { items: true, dishSales: true, branch: { select: { name: true } }, staff: { select: { name: true, username: true, role: true } } },
})

console.log('orders found:', orders.length)
for (const o of orders) {
  console.log('\n--', o.orderNumber, '| id:', o.id)
  console.log('   status:', o.status, '| deletedAt:', o.deletedAt, '| paidAt:', o.paidAt)
  console.log('   restaurantId:', o.restaurantId, '| branch:', o.branch?.name, o.branchId)
  console.log('   table:', o.tableName, '| createdByName:', o.createdByName, '| staff:', o.staff?.name, o.staff?.username, o.staff?.role)
  console.log('   total:', o.totalAmount, '| journalEntryId:', o.journalEntryId)
  console.log('   items:', o.items.map(i => `${i.dishName} x${i.qty} [${i.status}/${i.kitchenStatus}]`).join(', '))
  console.log('   dishSales:', o.dishSales.length)
}

const ids = orders.map(o => o.id)
if (ids.length) {
  const outbox = await prisma.syncOutbox.findMany({
    where: { OR: [{ entityId: { in: ids } }, { entityType: 'order', entityId: { in: ids } }] },
    select: { id: true, entityType: true, entityId: true, operation: true, syncedAt: true, mutationId: true, sourceDeviceId: true },
  })
  console.log('\noutbox rows referencing these order ids:', outbox.length)
  for (const r of outbox) console.log('  ', r.entityType, r.operation, r.entityId, 'synced:', !!r.syncedAt, r.sourceDeviceId)

  const itemIds = orders.flatMap(o => o.items.map(i => i.id))
  const itemOutbox = await prisma.syncOutbox.findMany({
    where: { entityId: { in: itemIds } },
    select: { id: true, entityType: true, entityId: true, operation: true, syncedAt: true },
  })
  console.log('outbox rows referencing their order items:', itemOutbox.length)

  // any outbox payload mentioning the order numbers
  const byNumber = await prisma.$queryRawUnsafe(
    `SELECT id, "entityType", "entityId", operation, "syncedAt" FROM sync_outbox WHERE ` +
      TARGET.map((_, i) => `payload LIKE $${i + 1}`).join(' OR '),
    ...TARGET.map(n => `%${n}%`)
  )
  console.log('outbox rows whose payload mentions the order numbers:', byNumber.length)
  for (const r of byNumber) console.log('  ', r.entityType, r.operation, r.entityId, 'synced:', !!r.syncedAt)
}

await prisma.$disconnect()
