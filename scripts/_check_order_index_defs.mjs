import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'
function readEnvVar(file, key) {
  const content = fs.readFileSync(file, 'utf8')
  const line = content.split('\n').find(l => l.startsWith(`${key}=`))
  return line ? line.slice(key.length + 1).trim().replace(/^"|"$/g, '') : null
}
const prisma = new PrismaClient({ datasources: { db: { url: readEnvVar('.env.local', 'DATABASE_URL') } } })
const rows = await prisma.$queryRawUnsafe(
  `SELECT indexdef FROM pg_indexes WHERE tablename = 'restaurant_orders' ORDER BY indexname`
)
for (const r of rows) console.log('  ' + r.indexdef)
const dupes = await prisma.$queryRawUnsafe(
  `SELECT "restaurantId", "orderNumber", COUNT(*) c FROM restaurant_orders
   GROUP BY 1,2 HAVING COUNT(*) > 1 LIMIT 5`
)
console.log('\nduplicate (restaurantId, orderNumber) pairs:', dupes.length)
for (const d of dupes) console.log('  ', d.orderNumber, '×', Number(d.c))
await prisma.$disconnect()
