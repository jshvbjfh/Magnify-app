import pkg from "@prisma/client";
const { PrismaClient, Prisma } = pkg;
const prisma = new PrismaClient();

async function main() {
  const restaurantId = "cmpfkza9u0003wwig4znjkpo9";
  const branchId = "cmpfkzavn0005wwig9i5m5bqx";
  const orderNumber = "ORD-000001";

  // Based on the column list: restaurantId, branchId, orderNumber, journalEntryId, tableId, paymentMethod, status, totalAmount etc are camelCase in DB or at least that is how information_schema reports them.
  // Wait, if it is Postgres, it is likely case-sensitive or quoted. 
  // Information schema returned: restaurantId, branchId, orderNumber etc.
  
  const orders = await prisma.$queryRaw`
    SELECT *
    FROM restaurant_orders
    WHERE "restaurantId" = ${restaurantId} AND "branchId" = ${branchId} AND "orderNumber" = ${orderNumber}
    LIMIT 1
  `;

  if (orders.length === 0) {
    console.log(JSON.stringify({ error: "Order not found" }));
    return;
  }
  const order = orders[0];

  // 2) select order_items
  const orderItems = await prisma.$queryRaw`
    SELECT * FROM order_items WHERE "orderId" = ${order.id}
  `;

  // 3) select dish_sales
  const dishSales = await prisma.$queryRaw`
    SELECT * FROM dish_sales WHERE "orderId" = ${order.id}
  `;

  // 4) journal_entry
  let journalEntry = null;
  let journalLines = [];
  if (order.journalEntryId) {
    const jid = order.journalEntryId;
    const entries = await prisma.$queryRaw`
      SELECT * FROM journal_entries WHERE id = ${jid}
    `;
    journalEntry = entries[0];
    const lines = await prisma.$queryRaw`
      SELECT * FROM journal_lines WHERE "journalEntryId" = ${jid}
    `;
    journalLines = lines;
  }

  // 5) table status
  const tid = order.tableId;
  let tableStatus = null;
  if (tid) {
    const tables = await prisma.$queryRaw`
      SELECT status FROM restaurant_tables WHERE id = ${tid}
    `;
    tableStatus = tables[0]?.status;
  }

  // 6) & 7)
  let dishSaleIngredients = [];
  let inventoryLedgers = [];
  if (dishSales.length > 0) {
    const ids = dishSales.map(ds => ds.id);
    for (const id of ids) {
      const ing = await prisma.$queryRaw`SELECT * FROM dish_sale_ingredients WHERE "dishSaleId" = ${id}`;
      dishSaleIngredients.push(...ing);
      const ledg = await prisma.$queryRaw`SELECT * FROM inventory_batch_usage_ledgers WHERE "sourceType" = 'dishSale' AND "sourceId" = ${id}`;
      inventoryLedgers.push(...ledg);
    }
  }

  console.log(JSON.stringify({
    order,
    orderItems,
    dishSales,
    journalEntry,
    journalLines,
    tableStatus,
    dishSaleIngredients,
    inventoryLedgers
  }, null, 2));
}

main().catch(e => { console.error(JSON.stringify({error: e.message})); process.exit(1); }).finally(() => prisma.$disconnect());
