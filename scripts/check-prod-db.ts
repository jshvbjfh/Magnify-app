import { PrismaClient } from '@prisma/client'

// Using production Neon DB
const p = new PrismaClient({
  datasources: {
    db: {
      url: 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
    },
  },
})

const restaurantId = 'cmon2714y0002k785sfpzm6vn'

async function main() {
  const orders = await (p as any).$queryRaw`
    SELECT id, status, order_number, created_at, paid_at
    FROM restaurant_orders
    WHERE restaurant_id = ${restaurantId}
    ORDER BY created_at
  `
  console.log('ORDERS:', JSON.stringify(orders, null, 2))

  const dishSales = await (p as any).$queryRaw`
    SELECT id, order_id, dish_id, quantity_sold, sale_date
    FROM dish_sales
    WHERE restaurant_id = ${restaurantId}
    LIMIT 10
  `
  console.log('\nDISH SALES count:', (dishSales as any[]).length)
  console.log(JSON.stringify(dishSales, null, 2))
}

main().then(() => p.$disconnect()).catch(e => { console.error(e.message); p.$disconnect() })
