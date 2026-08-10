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
const url = new URL(process.env.DATABASE_URL)
url.searchParams.set('connection_limit', '2')
url.searchParams.set('pool_timeout', '30')
const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } })

const items = await prisma.orderItem.findMany({
  where: { orderId: '0cecc78b-4583-4c3d-9955-1cf700f1328a' },
  select: { id: true, dishName: true, dishPrice: true, qty: true, totalPrice: true, status: true },
})
console.log(JSON.stringify(items, null, 2))

// Sample a few more recent order items to see if totalPrice is generally populated
const sample = await prisma.orderItem.findMany({
  where: { status: 'ACTIVE' },
  select: { id: true, dishName: true, dishPrice: true, qty: true, totalPrice: true },
  orderBy: { createdAt: 'desc' },
  take: 10,
})
console.log('\nRecent sample:')
console.log(JSON.stringify(sample, null, 2))

await prisma.$disconnect()
