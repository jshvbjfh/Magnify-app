import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: "postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
    },
  },
});

async function main() {
  const restaurantId = 'cmpelduka0002obyu77inyybz';
  const branchId = 'cmpeldv660004obyup3maoigb';
  const waiterEmail = 'kinyinyawaiterep@gmail.com';

  console.log('--- Restaurant & Branch Info ---');
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { name: true }
  });
  const branch = await prisma.branch.findUnique({
    where: { id: branchId },
    select: { name: true }
  });

  console.log('Restaurant Name:', restaurant?.name || 'Not Found');
  console.log('Branch Name:', branch?.name || 'Not Found');

  console.log('\n--- Staff Check ---');
  const staff = await prisma.staff.findFirst({
    where: { username: waiterEmail, restaurantId: restaurantId }
  });
  console.log(`Staff/User (${waiterEmail}):`, staff ? 'Exists (ID: ' + staff.id + ')' : 'Not Found');

  console.log('\n--- Dishes ---');
  const dishes = await prisma.dish.findMany({
    where: { restaurantId: restaurantId, branchId: branchId, isActive: true },
    select: { name: true }
  });
  console.log('Active dishes count:', dishes.length);
  console.log('First 10 dishes:', dishes.slice(0, 10).map(d => d.name).join(', '));

  console.log('\n--- Tables ---');
  // Check if Table model exists, case sensitive
  const tableModel = prisma.table || prisma.Table;
  if (!tableModel) {
      console.log('Table model not found in Prisma client. Available models:', Object.keys(prisma).filter(k => !k.startsWith('$')));
  } else {
      const tables = await tableModel.findMany({
        where: { restaurantId: restaurantId, branchId: branchId },
        select: { name: true }
      });
      console.log('Tables count:', tables.length);
      console.log('First 10 tables:', tables.slice(0, 10).map(t => t.name).join(', '));
  }
}

main()
  .catch(e => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
