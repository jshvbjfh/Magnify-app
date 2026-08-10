/** READ-ONLY: resolve the outbox-deleted dish ids + all soda/fanta-family
 *  dishes in Parking Bar (incl. deleted) with full state. */
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

const IDS = [
  'cmr1wfmcc0009uq3jt5k5zv1s',
  'cmqqhr2j9000rcnq3ga3o66w9',
  'cmqqhr4fn000tcnq3yb6zw2u7',
  'cmr1wfjo20001uq3jhh1f5b9c',
  'cmrkrl2og004l12s2ggbncv8n', // SODA (new)
  'cmrko7r9z001712s2fee3mxlk', // Cocktail Juice
]
const byId = await prisma.dish.findMany({
  where: { id: { in: IDS } },
  select: { id: true, name: true, category: true, isActive: true, deletedAt: true, sellingPrice: true, branch: { select: { name: true } } },
})
console.log('=== Outbox-referenced dishes ===')
for (const id of IDS) {
  const d = byId.find(x => x.id === id)
  console.log(d ? `${id} → ${d.branch.name} | ${d.category ?? '-'} | ${d.name} @ ${d.sellingPrice} active=${d.isActive}${d.deletedAt ? ' DELETED ' + d.deletedAt.toISOString() : ''}` : `${id} → NOT IN CLOUD DB`)
}

// All soda-family dishes in Parking Bar, incl. deleted
const family = await prisma.dish.findMany({
  where: {
    branchId: 'cmqiagbtb0010n5p1utvhc8s6',
    OR: ['Soda', 'Fanta', 'SODA', 'Citron', 'Fiesta', 'Orange'].map(n => ({ name: { contains: n } })),
  },
  select: { id: true, name: true, category: true, isActive: true, deletedAt: true, sellingPrice: true, createdAt: true },
  orderBy: { createdAt: 'asc' },
})
console.log('\n=== Soda/Fanta family in Parking Bar (incl. deleted) ===')
for (const d of family) console.log(`${d.id} | ${d.category ?? '-'} | ${d.name} @ ${d.sellingPrice} active=${d.isActive}${d.deletedAt ? ' DELETED ' + d.deletedAt.toISOString() : ''} created=${d.createdAt.toISOString()}`)

await prisma.$disconnect()
