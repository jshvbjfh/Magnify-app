import { PrismaClient } from '@prisma/client'
process.env.DATABASE_URL = 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require'
const p = new PrismaClient()
const restaurantId = 'cmqia7buf0003n5p19gkoov3k'

for (const branchName of ['Banana Bar', 'Parking Bar']) {
  const branch = await p.branch.findFirst({ where: { restaurantId, name: branchName } })
  const items = await p.inventoryItem.findMany({ where: { branchId: branch.id }, orderBy: { name: 'asc' }, select: { id: true, name: true, unit: true, quantity: true, unitCost: true } })
  console.log(`\n=== ${branchName} (${items.length} items) ===`)
  for (const i of items) console.log(` [${i.id}]`, i.name, '|', i.unit, '| qty:', i.quantity, '| cost:', i.unitCost)
}
await p.$disconnect()
