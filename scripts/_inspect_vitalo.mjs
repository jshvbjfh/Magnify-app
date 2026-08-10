/** READ-ONLY: Vitalo dish + inventory across High 5ive bar stations. */
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

const dishes = await prisma.dish.findMany({
  where: { name: { contains: 'Vitalo' } },
  select: {
    id: true, name: true, branchId: true, deletedAt: true, isActive: true,
    branch: { select: { name: true } },
    ingredients: { select: { id: true, quantityRequired: true, unit: true,
      inventoryItem: { select: { id: true, name: true, branchId: true, quantity: true, unit: true, unitCost: true } } } },
    _count: { select: { orderItems: true, dishSales: true } },
  },
})
console.log('Vitalo dishes:', JSON.stringify(dishes, null, 2))

const inv = await prisma.inventoryItem.findMany({
  where: { name: { contains: 'Vitalo' } },
  select: { id: true, name: true, branchId: true, branch: { select: { name: true } }, quantity: true, unit: true, unitCost: true, deletedAt: true,
    _count: { select: { purchases: true, dishIngredients: true } } },
})
console.log('Vitalo inventory items:', JSON.stringify(inv, null, 2))

await prisma.$disconnect()
