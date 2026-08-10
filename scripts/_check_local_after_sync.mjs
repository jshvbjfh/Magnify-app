import { PrismaClient } from '@prisma/client'

const dbPath = 'C:/Users/HP/AppData/Roaming/restaurant-app/data/dev.db'
const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } })

const restaurant = await prisma.restaurant.findFirst({ where: { name: 'High 5ive' } })
console.log('Restaurant:', restaurant?.id)

const [dishes, inventoryItems, staff, cursors] = await Promise.all([
  prisma.dish.count({ where: { restaurantId: restaurant.id } }),
  prisma.inventoryItem.count({ where: { restaurantId: restaurant.id } }),
  prisma.staff.count({ where: { restaurantId: restaurant.id } }),
  prisma.syncCursor.findMany({ where: { scopeId: restaurant.id } }),
])

console.log({ dishes, inventoryItems, staff })
console.log('Sync cursors:', cursors)

await prisma.$disconnect()
