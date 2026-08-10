import { PrismaClient } from '@prisma/client'
process.env.DATABASE_URL = 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require'
const p = new PrismaClient()
const restaurantId = 'cmqia7buf0003n5p19gkoov3k'
const SHOT_ML = 40

const ingredients = await p.dishIngredient.findMany({
  where: { dish: { restaurantId, deletedAt: null } },
  include: { dish: { select: { name: true } }, inventoryItem: { select: { name: true, unit: true } } },
})

for (const di of ingredients) {
  const stated = (di.unit ?? '').toLowerCase().trim()
  const real = (di.inventoryItem.unit ?? '').toLowerCase().trim()
  const norm = (u) => u.replace(/s$/, '')
  if (!stated || norm(stated) === norm(real)) continue

  // "1 shot" recipe against an ml-tracked item -> convert to ml
  if (norm(stated) === 'shot' && norm(real) === 'ml') {
    const newQty = di.quantityRequired * SHOT_ML
    await p.dishIngredient.update({ where: { id: di.id }, data: { quantityRequired: newQty, unit: 'ml' } })
    console.log(`FIXED: ${di.dish.name} -> ${di.inventoryItem.name}: ${di.quantityRequired} shot -> ${newQty} ml`)
    continue
  }

  // "15 ml" recipe against a shot-tracked item -> convert to shots
  if (norm(stated) === 'ml' && norm(real) === 'shot') {
    const newQty = Math.round((di.quantityRequired / SHOT_ML) * 1000) / 1000
    await p.dishIngredient.update({ where: { id: di.id }, data: { quantityRequired: newQty, unit: real } })
    console.log(`FIXED: ${di.dish.name} -> ${di.inventoryItem.name}: ${di.quantityRequired} ml -> ${newQty} ${real}`)
    continue
  }

  console.log(`UNHANDLED (needs manual review): ${di.dish.name} -> ${di.inventoryItem.name}: "${di.quantityRequired} ${di.unit}" vs stock "${di.inventoryItem.unit}"`)
}

await p.$disconnect()
