const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const restaurantId = 'cmowxtccg0001dndczpsixoml';
  const targetBranchId = 'cmowxtd6u0003dndc6u1h4y4k';

  try {
    const branches = await prisma.restaurantBranch.findMany({
      where: { restaurantId: restaurantId },
      select: { id: true, name: true }
    });
    console.log('--- Restaurant Branches ---');
    console.log('Count:', branches.length);
    console.log(JSON.stringify(branches, null, 2));

    const branchIds = branches.map(b => b.id);

    const dishCounts = await prisma.dish.groupBy({
      by: ['restaurantBranchId', 'isActive'],
      where: { restaurantBranchId: { in: branchIds } },
      _count: { id: true }
    });
    console.log('\n--- Dish Counts (Grouped by Branch/isActive) ---');
    console.log(JSON.stringify(dishCounts, null, 2));

    const tableCounts = await prisma.restaurantTable.groupBy({
      by: ['restaurantBranchId'],
      where: { restaurantBranchId: { in: branchIds } },
      _count: { id: true }
    });
    console.log('\n--- Table Counts (Grouped by Branch) ---');
    console.log(JSON.stringify(tableCounts, null, 2));

    // Orphan checks
    const orphanDishes = await prisma.dish.count({
      where: { 
        restaurantBranchId: { notIn: branchIds },
        // If we want to check if they belong to any known branch of this restaurant
      }
    });

    const orphanTables = await prisma.restaurantTable.count({
      where: { 
        restaurantBranchId: { notIn: branchIds }
      }
    });
    
    console.log('\n--- Orphan Checks ---');
    console.log('Dishes not matching restaurant branches:', orphanDishes);
    console.log('Tables not matching restaurant branches:', orphanTables);

  } catch (e) {
    console.error(e);
  } finally {
    await prisma.\();
  }
}

main();
