import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'
function env(k){const c=fs.readFileSync('.env.local','utf8');const l=c.split('\n').find(x=>x.startsWith(k+'='));return l?l.slice(k.length+1).trim().replace(/^"|"$/g,''):null}
const prisma = new PrismaClient({ datasources: { db: { url: env('DATABASE_URL') } } })
const u = await prisma.user.findMany({ where: { email: { endsWith: '@management.com' } }, select: { id: true } })
const rs = await prisma.restaurant.findMany({ where: { OR: [{ ownerId: { in: u.map(x=>x.id) } }, { managerId: { in: u.map(x=>x.id) } }] }, select: { id: true } })
const rows = await prisma.$queryRawUnsafe(
  `SELECT to_char(COALESCE("businessDate","paidAt"), 'YYYY-MM') AS month,
          COUNT(*)::int AS bills,
          MIN(COALESCE("businessDate","paidAt")) AS first,
          MAX(COALESCE("businessDate","paidAt")) AS last
   FROM restaurant_orders
   WHERE "restaurantId" = ANY($1) AND status = 'PAID' AND "deletedAt" IS NULL
   GROUP BY 1 ORDER BY 1`, rs.map(r=>r.id))
console.log('MONTH     BILLS   FIRST                LAST')
for (const r of rows) console.log(`${r.month}   ${String(r.bills).padStart(5)}   ${r.first?.toISOString().slice(0,10)}   ${r.last?.toISOString().slice(0,10)}`)
await prisma.$disconnect()
