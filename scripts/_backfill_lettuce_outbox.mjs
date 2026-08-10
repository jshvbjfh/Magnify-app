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
async function main() {
  const branch = await prisma.branch.findFirst({ where: { name: 'WHATABURGER' }, select: { id: true, restaurantId: true } })
  await prisma.syncOutbox.create({
    data: {
      scopeId: branch.restaurantId,
      restaurantId: branch.restaurantId,
      branchId: branch.id,
      entityType: 'inventoryItem',
      entityId: 'cmqjltcmq000h13q9wo43hsvg',
      operation: 'delete',
      payload: JSON.stringify({ id: 'cmqjltcmq000h13q9wo43hsvg' }),
      mutationId: crypto.randomUUID(),
      availableAt: new Date(),
    },
  })
  console.log('backfilled outbox entry for Lettuce leaf delete')
}
main().catch(e=>console.error('FATAL',e.message)).finally(()=>prisma.$disconnect())
