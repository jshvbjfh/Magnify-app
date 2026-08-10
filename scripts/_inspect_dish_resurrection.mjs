/** READ-ONLY: diagnose (1) new drink not reaching waiter app, (2) Soda Citron
 *  resurrecting after delete. Shows all matching dish rows incl. deleted,
 *  today's created/updated dishes, and related sync outbox rows. */
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

const user = await prisma.user.findUnique({ where: { email: 'high5ive@management.com' }, select: { id: true } })
const rest = await prisma.restaurant.findFirst({ where: { ownerId: user.id }, select: { id: true } })

// 1. All Soda Citron / Fanta Citron rows, deleted or not
const citron = await prisma.dish.findMany({
  where: { restaurantId: rest.id, name: { contains: 'itron' } },
  select: { id: true, name: true, isActive: true, deletedAt: true, createdAt: true, updatedAt: true, branch: { select: { name: true } } },
  orderBy: { createdAt: 'asc' },
})
console.log('=== Citron dishes (all, incl. deleted) ===')
for (const d of citron) console.log(JSON.stringify(d))

// 2. Dishes created or updated in the last 24h
const since = new Date(Date.now() - 24 * 3600 * 1000)
const recent = await prisma.dish.findMany({
  where: { restaurantId: rest.id, OR: [{ createdAt: { gte: since } }, { updatedAt: { gte: since } }] },
  select: { id: true, name: true, category: true, deletedAt: true, createdAt: true, updatedAt: true, branch: { select: { name: true } } },
  orderBy: { updatedAt: 'desc' },
})
console.log(`\n=== Dishes created/updated in last 24h (${recent.length}) ===`)
for (const d of recent) {
  const isNew = d.createdAt >= since
  console.log(`${isNew ? 'NEW ' : 'UPD '} ${d.branch.name} | ${d.category ?? '-'} | ${d.name}${d.deletedAt ? ' [DELETED ' + d.deletedAt.toISOString() + ']' : ''} created=${d.createdAt.toISOString()} updated=${d.updatedAt.toISOString()}`)
}

// 3. Sync outbox rows for dishes in the last 24h
const outbox = await prisma.syncOutbox.findMany({
  where: { restaurantId: rest.id, entityType: 'dish', createdAt: { gte: since } },
  select: { entityId: true, operation: true, sourceDeviceId: true, createdAt: true },
  orderBy: { createdAt: 'desc' },
  take: 40,
})
console.log(`\n=== dish outbox rows last 24h (${outbox.length}) ===`)
for (const o of outbox) console.log(`${o.createdAt.toISOString()} ${o.operation} ${o.entityId} from=${o.sourceDeviceId}`)

await prisma.$disconnect()
