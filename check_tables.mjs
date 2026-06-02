import pkg from "@prisma/client";
const { PrismaClient } = pkg;
const prisma = new PrismaClient();

async function main() {
  const tables = await prisma.$queryRawUnsafe(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
  `);
  console.log(JSON.stringify(tables, null, 2));
}

main()
  .catch(e => { console.error(JSON.stringify({error: e.message})); process.exit(1); })
  .finally(() => prisma.$disconnect());
