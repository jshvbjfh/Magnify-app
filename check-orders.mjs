import { PrismaClient } from "@prisma/client";
import fs from "fs";
import dotenv from "dotenv";

async function main() {
  const envContent = fs.readFileSync(".env.vercel.production", "utf8");
  const env = dotenv.parse(envContent);
  const url = env.DATABASE_URL;
  
  if (!url) {
    console.error("DATABASE_URL not found in .env.vercel.production");
    process.exit(1);
  }

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: url,
      },
    },
  });

  try {
    const orders = await prisma.restaurantOrder.findMany({
      where: {
        tableId: "cmpfbip1z00061379uvsskoa5",
      },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        createdByName: true,
        createdAt: true,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 3,
    });

    console.log("Latest 3 orders for table cmpfbip1z00061379uvsskoa5:");
    console.log(JSON.stringify(orders, null, 2));

    if (orders.length > 0) {
      const newestOrder = orders[0];
      console.log(`\nNewest order status: ${newestOrder.status}`);
      console.log(`Is newest order PENDING? ${newestOrder.status === "PENDING"}`);
    } else {
      console.log("\nNo orders found for this table.");
    }
  } catch (error) {
    console.error("Error fetching orders:", error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
