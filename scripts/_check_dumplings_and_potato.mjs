/** READ-ONLY: check Signature Dumplings (Pan-fried) recipe/cost, and the
 *  Potato item in WHATABURGER station for high5ive@management.com. */
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
url.searchParams.set('connection_limit', '3')
url.searchParams.set('pool_timeout', '30')
const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } })

const user = await prisma.user.findUnique({ where: { email: 'high5ive@management.com' }, select: { id: true } })
const rest = await prisma.restaurant.findFirst({ where: { ownerId: user.id }, select: { id: true } })

console.log('=== Signature Dumplings (Pan-fried) ===')
const dumplings = await prisma.dish.findMany({
  where: { restaurantId: rest.id, name: { contains: 'Dumplings', mode: 'insensitive' } },
  select: {
    id: true, name: true, category: true, sellingPrice: true, deletedAt: true, isActive: true,
    preparedPortions: true, preparedPortionCost: true,
    branch: { select: { name: true } },
    ingredients: { select: { quantityRequired: true, inventoryItem: { select: { name: true, unit: true, unitCost: true, quantity: true } } } },
  },
})
for (const d of dumplings) {
  console.log(`  [${d.id}] ${d.branch.name} | ${d.name} @ ${d.sellingPrice} | preparedPortions=${d.preparedPortions} preparedPortionCost=${d.preparedPortionCost}${d.deletedAt ? ' [DELETED]' : ''}${d.isActive ? '' : ' [INACTIVE]'}`)
  if (!d.ingredients.length) console.log('     ⚠ NO INGREDIENTS LINKED (recipe empty)')
  for (const i of d.ingredients) console.log(`     - ${i.inventoryItem.name}: ${i.quantityRequired}${i.inventoryItem.unit} @ unitCost=${i.inventoryItem.unitCost} (stock: ${i.inventoryItem.quantity})`)
}

console.log('\n=== Recent DishSale rows for these dishes ===')
const sales = await prisma.dishSale.findMany({
  where: { dishId: { in: dumplings.map(d => d.id) } },
  orderBy: { createdAt: 'desc' },
  take: 5,
  select: { id: true, dishId: true, quantitySold: true, calculatedFoodCost: true, totalSaleAmount: true, createdAt: true, orderId: true, orderItemId: true },
})
for (const s of sales) console.log(`  ${s.createdAt.toISOString()} orderId=${s.orderId} orderItemId=${s.orderItemId} qty=${s.quantitySold} calculatedFoodCost=${s.calculatedFoodCost} totalSaleAmount=${s.totalSaleAmount}`)

console.log('\n=== Potato item(s) in WHATABURGER ===')
const whataburger = await prisma.branch.findFirst({ where: { restaurantId: rest.id, name: { contains: 'WHATABURGER', mode: 'insensitive' } }, select: { id: true, name: true } })
console.log('branch:', whataburger)
const potatoes = await prisma.inventoryItem.findMany({
  where: { restaurantId: rest.id, branchId: whataburger?.id, name: { contains: 'potato', mode: 'insensitive' } },
  select: { id: true, name: true, unit: true, quantity: true, unitCost: true, type: true, deletedAt: true, createdAt: true, updatedAt: true },
})
for (const p of potatoes) console.log(' ', JSON.stringify(p))

if (potatoes.length) {
  console.log('\n=== InventoryPurchase rows for Potato ===')
  const purchases = await prisma.inventoryPurchase.findMany({
    where: { ingredientId: { in: potatoes.map(p => p.id) } },
    orderBy: { createdAt: 'desc' },
    take: 20,
  })
  for (const pu of purchases) console.log(' ', JSON.stringify(pu))

  console.log('\n=== DishIngredient references to Potato ===')
  const refs = await prisma.dishIngredient.findMany({
    where: { inventoryItemId: { in: potatoes.map(p => p.id) } },
    select: { id: true, quantityRequired: true, dish: { select: { name: true, deletedAt: true } } },
  })
  for (const r of refs) console.log(' ', JSON.stringify(r))
}

await prisma.$disconnect()
