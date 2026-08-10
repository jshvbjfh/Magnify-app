import { PrismaClient } from '@prisma/client'
process.env.DATABASE_URL = 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require'
const p = new PrismaClient()
const restaurantId = 'cmqia7buf0003n5p19gkoov3k'

const branches = await p.branch.findMany({ where: { restaurantId, deletedAt: null, name: { notIn: ['Banana Bar'] } } })

for (const branch of branches) {
  const dishes = await p.dish.findMany({
    where: { branchId: branch.id, deletedAt: null },
    include: { ingredients: { include: { inventoryItem: true } } },
  })
  const noRecipe = dishes.filter(d => d.ingredients.length === 0)
  const zeroStockMap = new Map()
  for (const d of dishes) {
    for (const di of d.ingredients) {
      if (Number(di.inventoryItem.quantity) > 0) continue
      if (!zeroStockMap.has(di.inventoryItem.id)) zeroStockMap.set(di.inventoryItem.id, { item: di.inventoryItem, dishes: [] })
      zeroStockMap.get(di.inventoryItem.id).dishes.push(d.name)
    }
  }

  console.log(`\n${'='.repeat(70)}\n${branch.name} — ${dishes.length} dishes, ${noRecipe.length} with NO recipe, ${zeroStockMap.size} zero-stock ingredients in use\n${'='.repeat(70)}`)
  if (noRecipe.length) console.log('NO RECIPE:', noRecipe.map(d => d.name).join(', '))
  for (const { item, dishes: ds } of zeroStockMap.values()) {
    console.log(`  ${item.name} | unit:${item.unit} | cost:${item.unitCost} | used in: ${ds.join(', ')}`)
  }
}
await p.$disconnect()
