import { PrismaClient } from '@prisma/client'
process.env.DATABASE_URL = 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require'
const p = new PrismaClient()
const restaurantId = 'cmqia7buf0003n5p19gkoov3k'

for (const branchName of ['Banana Bar', 'Parking Bar']) {
  const branch = await p.branch.findFirst({ where: { restaurantId, name: branchName } })
  const shotItems = await p.inventoryItem.findMany({ where: { branchId: branch.id, unit: { in: ['shot', 'shots'] } } })
  console.log(`\n=== ${branchName}: shot-unit items (${shotItems.length}) ===`)
  for (const item of shotItems) {
    const usedIn = await p.dishIngredient.findMany({ where: { inventoryItemId: item.id }, include: { dish: { select: { name: true } } } })
    console.log(` ${item.name} (qty:${item.quantity}, cost:${item.unitCost}) used in:`, usedIn.map(u => `${u.dish.name} (${u.quantityRequired} ${u.unit ?? item.unit})`).join(', '))
  }
}
await p.$disconnect()
