/** READ-ONLY: find stock items tracked in bulk units (kg/ltr) that appear in
 *  recipes — sales consume the raw recipe number in the item's unit, so any
 *  gram-intent recipe line silently drains these. */
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

const bulkItems = await prisma.inventoryItem.findMany({
  where: { restaurantId: rest.id, deletedAt: null, unit: { in: ['kg', 'Kg', 'KG', 'ltr', 'Ltr', 'L', 'l'] } },
  select: {
    name: true, unit: true, quantity: true, unitCost: true,
    branch: { select: { name: true } },
    dishIngredients: {
      where: { dish: { deletedAt: null, isActive: true } },
      select: { quantityRequired: true, unit: true, dish: { select: { name: true } } },
    },
  },
  orderBy: [{ branchId: 'asc' }, { name: 'asc' }],
})

for (const it of bulkItems) {
  const flag = it.dishIngredients.length ? '⚠ USED IN RECIPES' : '(not in any active recipe)'
  console.log(`${it.branch.name} | ${it.name} — ${it.quantity}${it.unit} @ ${it.unitCost}/${it.unit} ${flag}`)
  for (const di of it.dishIngredients) {
    console.log(`    ${di.dish.name}: uses ${di.quantityRequired}${di.unit ?? it.unit}`)
  }
}

await prisma.$disconnect()
