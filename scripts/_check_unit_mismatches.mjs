import { PrismaClient } from '@prisma/client'
process.env.DATABASE_URL = 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require'
const p = new PrismaClient()
const restaurantId = 'cmqia7buf0003n5p19gkoov3k'

const ingredients = await p.dishIngredient.findMany({
  where: { dish: { restaurantId, deletedAt: null } },
  include: { dish: { select: { name: true, branchId: true } }, inventoryItem: { select: { name: true, unit: true } } },
})

const mismatches = ingredients.filter(di => {
  const stated = (di.unit ?? '').toLowerCase().trim()
  const real = (di.inventoryItem.unit ?? '').toLowerCase().trim()
  if (!stated) return false
  // treat obvious equivalents as matching
  const norm = (u) => u.replace(/s$/, '')
  return norm(stated) !== norm(real)
})

console.log('Total dish-ingredient rows:', ingredients.length)
console.log('Rows where stated unit != actual inventory unit:', mismatches.length)
for (const m of mismatches) {
  console.log(` ${m.dish.name} -> ${m.inventoryItem.name}: recipe says "${m.quantityRequired} ${m.unit}" but stock is tracked in "${m.inventoryItem.unit}"`)
}
await p.$disconnect()
