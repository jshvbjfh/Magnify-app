/** READ-ONLY: full detail of the suspicious Little Taipei meat items + their
 *  purchase rows, before fixing unit costs. */
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

const LT = 'cmqiad2vx000in5p176jvqush'
const items = await prisma.inventoryItem.findMany({
  where: { branchId: LT, name: { in: ['Beef (strips)', 'Chicken breast', 'Chicken thigh (pieces)'] } },
  select: {
    id: true, name: true, unit: true, unitCost: true, quantity: true, type: true, deletedAt: true,
    purchases: { select: { id: true, batchId: true, purchaseQuantity: true, purchaseUnit: true, unitsPerPurchaseUnit: true, purchaseUnitCost: true, quantityPurchased: true, remainingQuantity: true, unitCost: true, totalCost: true, deletedAt: true } },
  },
})
console.log(JSON.stringify(items, null, 2))
await prisma.$disconnect()
