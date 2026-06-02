import pkg from "@prisma/client";
const { PrismaClient } = pkg;
const prisma = new PrismaClient();

async function main() {
  const tables = ['dish_sales', 'inventory_items', 'restaurant_orders'];
  const columns = await prisma.$queryRawUnsafe(`
    SELECT table_name, column_name, is_nullable, data_type, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name IN ('dish_sales', 'inventory_items', 'restaurant_orders')
    ORDER BY table_name, ordinal_position
  `);
  console.log(JSON.stringify(columns));
}

main()
  .catch(e => { console.error(JSON.stringify({error: e.message})); process.exit(1); })
  .finally(() => prisma.$disconnect());
