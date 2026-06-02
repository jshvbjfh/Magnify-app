import { PrismaClient } from "@prisma/client"
const prisma = new PrismaClient()

async function main() {
  const restaurantId = "cmpfkza9u0003wwig4znjkpo9"
  const branchId = "cmpfkzavn0005wwig9i5m5bqx"
  const orderNumber = "ORD-000001"

  const order = await prisma.restaurantOrder.findFirst({
    where: {
      restaurantId,
      branchId,
      orderNumber
    },
    include: {
      items: true,
      journalEntry: true,
      inventoryBatchUsageLedger: true
    }
  })

  if (!order) {
    console.log("Order not found")
    return
  }

  let tableStatus = null
  if (order.tableId) {
    tableStatus = await prisma.restaurantTable.findUnique({
      where: { id: order.tableId },
      select: { id: true, name: true, status: true }
    })
  }
  
  // Note: dishSales are not directly linked to RestaurantOrder in the include options provided by error.
  // We will check for dishSales separately if they are related via orderItems (items).

  console.log(JSON.stringify({ order, tableStatus }, null, 2))
}

main()
  .catch(e => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
