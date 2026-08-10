/** READ-ONLY: Salt + Bell pepper (mixed) — items, purchases, recipe links,
 *  and recent usage, to explain 0-on-hand salt and the FIFO blend figure. */
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

for (const name of ['Salt', 'Bell pepper (mixed)']) {
  const items = await prisma.inventoryItem.findMany({
    where: { restaurantId: rest.id, name: { contains: name.split(' ')[0] }, deletedAt: null },
    select: {
      id: true, name: true, unit: true, unitCost: true, quantity: true,
      branch: { select: { name: true } },
      purchases: {
        where: { deletedAt: null },
        orderBy: { purchasedAt: 'asc' },
        select: { batchId: true, purchaseQuantity: true, purchaseUnit: true, unitsPerPurchaseUnit: true, purchaseUnitCost: true, quantityPurchased: true, remainingQuantity: true, unitCost: true, totalCost: true, purchasedAt: true },
      },
      dishIngredients: {
        select: { quantityRequired: true, unit: true, dish: { select: { name: true, branch: { select: { name: true } } } } },
      },
    },
  })
  for (const it of items) {
    console.log(`\n=== ${it.branch.name} | ${it.name} — unit=${it.unit} qty=${it.quantity} cost=${it.unitCost} ===`)
    for (const p of it.purchases) {
      console.log(`  batch ${p.batchId ?? 'NO-ID'} @ ${p.purchasedAt.toISOString().slice(0, 10)}: bought ${p.purchaseQuantity ?? p.quantityPurchased}${p.purchaseUnit ?? it.unit} (=${p.quantityPurchased}${it.unit}) remaining ${p.remainingQuantity} @ ${p.unitCost}/${it.unit} total ${p.totalCost}`)
    }
    for (const di of it.dishIngredients) {
      console.log(`  recipe: ${di.dish.branch.name} | ${di.dish.name} uses ${di.quantityRequired}${di.unit ?? it.unit}`)
    }
  }
}

await prisma.$disconnect()
