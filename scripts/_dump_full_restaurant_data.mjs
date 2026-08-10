import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'

function readEnvVar(file, key) {
  const content = fs.readFileSync(file, 'utf8')
  const line = content.split('\n').find(l => l.startsWith(`${key}=`))
  if (!line) return null
  return line.slice(key.length + 1).trim().replace(/^"|"$/g, '')
}

const url = readEnvVar('.env.local', 'DATABASE_URL')
const prisma = new PrismaClient({ datasources: { db: { url } } })

const restaurantId = 'cmqia7buf0003n5p19gkoov3k'
const where = { restaurantId }

const dump = {}

dump.dish = await prisma.dish.findMany({ where })
const dishIds = dump.dish.map(d => d.id)

dump.dishVariant = await prisma.dishVariant.findMany({ where: { dishId: { in: dishIds } } })
dump.inventoryItem = await prisma.inventoryItem.findMany({ where })
const inventoryIds = dump.inventoryItem.map(i => i.id)

dump.dishIngredient = await prisma.dishIngredient.findMany({ where: { dishId: { in: dishIds } } })
dump.restaurantTable = await prisma.restaurantTable.findMany({ where })
dump.inventoryPurchase = await prisma.inventoryPurchase.findMany({ where })
dump.inventoryBatchUsageLedger = await prisma.inventoryBatchUsageLedger.findMany({ where })
dump.inventoryAdjustmentLog = await prisma.inventoryAdjustmentLog.findMany({ where })
dump.restaurantOrder = await prisma.restaurantOrder.findMany({ where })
const orderIds = dump.restaurantOrder.map(o => o.id)

dump.orderItem = await prisma.orderItem.findMany({ where: { orderId: { in: orderIds } } })
dump.dishSale = await prisma.dishSale.findMany({ where })
const dishSaleIds = dump.dishSale.map(s => s.id)

dump.dishSaleIngredient = await prisma.dishSaleIngredient.findMany({ where: { dishSaleId: { in: dishSaleIds } } })
dump.wasteLog = await prisma.wasteLog.findMany({ where })
dump.mepListItem = await prisma.mepListItem.findMany({ where })
const mepIds = dump.mepListItem.map(m => m.id)
dump.prepLog = await prisma.prepLog.findMany({ where })
dump.employeeShift = await prisma.employeeShift.findMany({ where })

fs.writeFileSync('scripts/_full_restaurant_dump.json', JSON.stringify(dump, null, 2))

for (const [key, rows] of Object.entries(dump)) {
  console.log(key.padEnd(28), rows.length)
}

await prisma.$disconnect()
