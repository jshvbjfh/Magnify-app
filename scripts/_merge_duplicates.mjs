import { PrismaClient } from '@prisma/client'
process.env.DATABASE_URL = 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require'
const p = new PrismaClient()
const restaurantId = 'cmqia7buf0003n5p19gkoov3k'
const bananaBar = await p.branch.findFirst({ where: { restaurantId, name: 'Banana Bar' } })
const SHOT_ML = 40

const merges = [
  { from: 'Gordon Gin', to: 'Gin Gordon' },
  { from: 'Martini', to: 'Martini Rosso' },
  { from: 'Olmeca Tequila', to: 'Olmeca Silver' },
]

for (const { from, to } of merges) {
  const fromItem = await p.inventoryItem.findFirst({ where: { branchId: bananaBar.id, name: from } })
  const toItem = await p.inventoryItem.findFirst({ where: { branchId: bananaBar.id, name: to } })
  if (!fromItem || !toItem) { console.log(`SKIP ${from} -> ${to}: item not found`); continue }

  const recipes = await p.dishIngredient.findMany({ where: { inventoryItemId: fromItem.id }, include: { dish: { select: { name: true } } } })
  console.log(`\n${from} (${fromItem.unit}, 0 stock) -> ${to} (${toItem.unit}, ${toItem.quantity} in stock)`)
  for (const r of recipes) {
    // r.quantityRequired is in "shot" (1 shot) -> convert to ml
    const newQty = r.quantityRequired * SHOT_ML
    // unique constraint on [dishId, inventoryItemId] — if the dish somehow already
    // has a row for `toItem`, skip to avoid a collision (shouldn't happen here).
    const existing = await p.dishIngredient.findFirst({ where: { dishId: r.dishId, inventoryItemId: toItem.id } })
    if (existing) { console.log(`  SKIP ${r.dish.name}: already has a ${to} ingredient row`); continue }
    await p.dishIngredient.update({ where: { id: r.id }, data: { inventoryItemId: toItem.id, quantityRequired: newQty, unit: 'ml' } })
    console.log(`  ${r.dish.name}: repointed, ${r.quantityRequired} shot -> ${newQty} ml`)
  }

  // fromItem is now unused (0 stock, no recipes) — safe to remove if no sale/waste history
  const dsi = await p.dishSaleIngredient.count({ where: { ingredientId: fromItem.id } })
  const waste = await p.wasteLog.count({ where: { ingredientId: fromItem.id } })
  const ledger = await p.inventoryBatchUsageLedger.count({ where: { ingredientId: fromItem.id } })
  const purchases = await p.inventoryPurchase.count({ where: { ingredientId: fromItem.id } })
  console.log(`  ${from} history: dsi=${dsi} waste=${waste} ledger=${ledger} purchases=${purchases}`)
  if (dsi === 0 && waste === 0 && ledger === 0) {
    await p.inventoryItem.delete({ where: { id: fromItem.id } })
    console.log(`  Deleted empty duplicate: ${from}`)
  } else {
    console.log(`  NOT deleted — has history, left in place`)
  }
}

await p.$disconnect()
