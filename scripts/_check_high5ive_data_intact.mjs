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

const restaurant = await prisma.restaurant.findFirst({ where: { name: 'High 5ive' } })
console.log('Restaurant:', restaurant?.id, restaurant?.name, 'deletedAt:', restaurant?.deletedAt)

const [dishes, dishSales, inventoryItems, branches, staff] = await Promise.all([
  prisma.dish.count({ where: { restaurantId: restaurant.id } }),
  prisma.dishSale.count({ where: { restaurantId: restaurant.id } }),
  prisma.inventoryItem.count({ where: { restaurantId: restaurant.id } }),
  prisma.branch.count({ where: { restaurantId: restaurant.id } }),
  prisma.staff.count({ where: { restaurantId: restaurant.id } }),
])

console.log({ dishes, dishSales, inventoryItems, branches, staff })

await prisma.$disconnect()
