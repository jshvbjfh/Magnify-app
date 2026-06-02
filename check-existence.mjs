import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: process.env.DATABASE_URL
      }
    }
  });

  try {
    const user = await prisma.user.findUnique({
      where: { email: 'erickapizzeria.waiter.0521@gmail.com' }
    });
    console.log('User exists:', !!user);
    if (user) {
        console.log('User details:', JSON.stringify(user, null, 2));
    }

    const staff = await prisma.staff.findFirst({
      where: { username: 'erickapizzeria.waiter.0521@gmail.com' }
    });
    console.log('Staff exists:', !!staff);
    if (staff) {
        console.log('Staff details:', JSON.stringify(staff, null, 2));
    }
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await prisma.$disconnect();
  }
}

main();
