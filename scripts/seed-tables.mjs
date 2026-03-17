import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

const EMAIL = 'gboy@gmail.com'

const TABLE_NAMES = [
  'T1','T2','T3','T4','T5','T6','T7','T8',
  'T9','T10','T11','T12','T13','T14','T15',
]

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)] }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min }

async function main() {
  const user = await prisma.user.findUnique({ where: { email: EMAIL } })
  if (!user) { console.error(`❌ User ${EMAIL} not found`); process.exit(1) }

  const restaurant = await prisma.restaurant.findUnique({ where: { ownerId: user.id } })
  if (!restaurant) { console.error('❌ No restaurant found for this user'); process.exit(1) }

  console.log(`✅ Restaurant: ${restaurant.name}`)

  // Fetch dishes
  const dishes = await prisma.dish.findMany({ where: { userId: user.id, isActive: true } })
  if (dishes.length === 0) { console.error('❌ No dishes found — run seed-menu first'); process.exit(1) }

  // Clear existing tables + pending orders for a clean slate
  await prisma.pendingOrder.deleteMany({ where: { restaurantId: restaurant.id } })
  await prisma.restaurantTable.deleteMany({ where: { restaurantId: restaurant.id } })
  console.log('🗑️  Cleared existing tables and pending orders')

  let tableCount = 0, orderCount = 0

  for (const name of TABLE_NAMES) {
    const table = await prisma.restaurantTable.create({
      data: {
        restaurantId: restaurant.id,
        name,
        seats: pick([2, 4, 4, 4, 6, 8]),
        status: 'occupied',
      },
    })
    tableCount++

    // Each table gets 1–4 random dish orders
    const numOrders = randInt(1, 4)
    const usedDishIds = new Set()

    for (let i = 0; i < numOrders; i++) {
      // Avoid duplicate dishes on same table
      let dish
      let attempts = 0
      do { dish = pick(dishes); attempts++ } while (usedDishIds.has(dish.id) && attempts < 20)
      usedDishIds.add(dish.id)

      await prisma.pendingOrder.create({
        data: {
          restaurantId: restaurant.id,
          tableId:      table.id,
          tableName:    table.name,
          dishId:       dish.id,
          dishName:     dish.name,
          dishPrice:    dish.sellingPrice,
          qty:          randInt(1, 3),
          waiterId:     user.id,
        },
      })
      orderCount++
    }

    console.log(`  🪑 ${name} — ${numOrders} order(s)`)
  }

  console.log(`\n✅ Done! Tables: ${tableCount}  |  Pending orders: ${orderCount}`)
}

main().finally(() => prisma.$disconnect())
