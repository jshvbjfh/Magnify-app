import { PrismaClient } from '@prisma/client'

process.env.DATABASE_URL = 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require'

const p = new PrismaClient()

const restaurantId = 'cmon2714y0002k785sfpzm6vn'

const orders = await p.restaurantOrder.findMany({
  where: { restaurantId },
  select: { id: true, status: true, orderNumber: true, createdAt: true, paidAt: true },
  orderBy: { createdAt: 'asc' },
  take: 10,
})
console.log('ORDERS:')
for (const o of orders) console.log(' ', o.orderNumber, o.status, o.id, o.createdAt)

const dishSales = await p.dishSale.findMany({
  where: { restaurantId },
  select: { id: true, orderId: true, dishId: true, quantitySold: true, saleDate: true },
  take: 10,
})
console.log('\nDISH SALES:', dishSales.length)
for (const s of dishSales) console.log(' orderId:', s.orderId, 'dish:', s.dishId, 'qty:', s.quantitySold)

await p.$disconnect()
