/** READ-ONLY: WHATABURGER Pickles — item, purchases, recipes, consumption. */
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

const items = await prisma.inventoryItem.findMany({
  where: { name: { contains: 'ickle' }, deletedAt: null },
  select: {
    id: true, name: true, unit: true, unitCost: true, quantity: true,
    branch: { select: { name: true } },
    purchases: { where: { deletedAt: null }, select: { batchId: true, purchaseQuantity: true, purchaseUnit: true, unitsPerPurchaseUnit: true, purchaseUnitCost: true, quantityPurchased: true, remainingQuantity: true, unitCost: true, totalCost: true } },
    dishIngredients: { select: { quantityRequired: true, unit: true, dish: { select: { name: true, deletedAt: true } } } },
    _count: { select: { batchUsageLedgers: true, saleIngredients: true } },
  },
})
console.log(JSON.stringify(items, null, 2))
await prisma.$disconnect()
