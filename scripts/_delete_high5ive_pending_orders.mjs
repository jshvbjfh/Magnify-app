/**
 * Hard-deletes four High 5ive waiter pending orders from the cloud DB and the
 * desktop local SQLite. Not a cancel — the rows are removed outright.
 * Backs up every row it touches to scratchpad JSON before deleting.
 */
import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

function readEnvVar(file, key) {
  const content = fs.readFileSync(file, 'utf8')
  const line = content.split('\n').find(l => l.startsWith(`${key}=`))
  if (!line) return null
  return line.slice(key.length + 1).trim().replace(/^"|"$/g, '')
}

const TARGET = ['WA-126872DB', 'WA-B348F7FB', 'WA-5CAA054C', 'WA-F3E86287']
const BACKUP_DIR =
  'C:/Users/HP/AppData/Local/Temp/claude/c--Users-HP-Documents-restaurant-app/8b72d10c-7969-47bf-a4fd-9c784d2d89d3/scratchpad'
const DESKTOP_DB = 'C:/Users/HP/AppData/Roaming/restaurant-app/data/dev.db'

const prisma = new PrismaClient({ datasources: { db: { url: readEnvVar('.env.local', 'DATABASE_URL') } } })

// ─── Cloud (Neon) ───────────────────────────────────────────────────────────
const orders = await prisma.restaurantOrder.findMany({
  where: { orderNumber: { in: TARGET } },
  include: { items: true, dishSales: true },
})
const ids = orders.map(o => o.id)

const blockers = orders.filter(o => o.dishSales.length > 0 || o.journalEntryId || o.paidAt)
if (blockers.length) {
  console.error('ABORT — these orders have sales/accounting attached:', blockers.map(o => o.orderNumber))
  process.exit(1)
}

const outbox = ids.length
  ? await prisma.syncOutbox.findMany({ where: { entityId: { in: ids } } })
  : []

fs.writeFileSync(
  `${BACKUP_DIR}/deleted-orders-backup.json`,
  JSON.stringify({ deletedAt: new Date().toISOString(), orders, outbox }, null, 2)
)
console.log(`backup written: ${orders.length} orders, ${outbox.length} outbox rows`)

const res = await prisma.$transaction(async tx => {
  // Outbox first: these unsynced upserts would re-broadcast the orders to every
  // device otherwise.
  const ob = await tx.syncOutbox.deleteMany({ where: { entityId: { in: ids } } })
  const it = await tx.orderItem.deleteMany({ where: { orderId: { in: ids } } })
  const or = await tx.restaurantOrder.deleteMany({ where: { id: { in: ids } } })
  return { ob: ob.count, it: it.count, or: or.count }
})
console.log(`CLOUD deleted -> outbox: ${res.ob}, items: ${res.it}, orders: ${res.or}`)

const left = await prisma.restaurantOrder.count({ where: { orderNumber: { in: TARGET } } })
console.log('CLOUD remaining with those numbers:', left)

await prisma.$disconnect()

// ─── Desktop local SQLite ───────────────────────────────────────────────────
const db = new DatabaseSync(DESKTOP_DB)
const placeholders = TARGET.map(() => '?').join(',')
const localOrders = db.prepare(`SELECT * FROM restaurant_orders WHERE orderNumber IN (${placeholders})`).all(...TARGET)
const localIds = localOrders.map(o => o.id)

if (localIds.length) {
  const idPh = localIds.map(() => '?').join(',')
  const localItems = db.prepare(`SELECT * FROM order_items WHERE orderId IN (${idPh})`).all(...localIds)
  fs.writeFileSync(
    `${BACKUP_DIR}/deleted-orders-backup-local.json`,
    JSON.stringify({ orders: localOrders, items: localItems }, null, 2)
  )
  const di = db.prepare(`DELETE FROM order_items WHERE orderId IN (${idPh})`).run(...localIds)
  const dsale = db.prepare(`DELETE FROM dish_sales WHERE orderId IN (${idPh})`).run(...localIds)
  const dor = db.prepare(`DELETE FROM restaurant_orders WHERE id IN (${idPh})`).run(...localIds)
  console.log(`LOCAL deleted -> items: ${di.changes}, dishSales: ${dsale.changes}, orders: ${dor.changes}`)
} else {
  console.log('LOCAL: nothing to delete')
}

const localLeft = db.prepare(`SELECT count(*) c FROM restaurant_orders WHERE orderNumber IN (${placeholders})`).get(...TARGET)
console.log('LOCAL remaining with those numbers:', localLeft.c)
db.close()
