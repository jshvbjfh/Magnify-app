const { PrismaClient } = require('@prisma/client');
const dotenv = require('dotenv');
const fs = require('fs');

async function main() {
  if (fs.existsSync('.env.vercel.production')) {
    const envConfig = dotenv.parse(fs.readFileSync('.env.vercel.production'));
    for (const k in envConfig) {
      process.env[k] = envConfig[k];
    }
  }

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: process.env.DATABASE_URL
      }
    }
  });

  try {
    const result = await prisma.$queryRawUnsafe(
      select table_name, column_name, is_nullable, data_type, column_default 
      from information_schema.columns 
      where table_schema = 'public' 
      and table_name in ('dish_sales','dish_sale_ingredients') 
      order by table_name, ordinal_position
    );
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
