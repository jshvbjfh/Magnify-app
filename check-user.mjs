import { PrismaClient } from '@prisma/client';

async function checkUser() {
  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: "postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
      },
    },
  });

  try {
    const email = 'erickapizzeria.waiter.0521@gmail.com';
    
    console.log(`Checking rows for: ${email}`);
    
    const user = await prisma.user.findUnique({
      where: { email }
    });
    
    const staff = await prisma.staff.findMany({
      where: { username: email }
    });

    console.log('User row:', JSON.stringify(user, null, 2));
    console.log('Staff row:', JSON.stringify(staff, null, 2));
    
    if (user && staff.length > 0) {
      console.log('RESULT: Both user and staff rows exist.');
    } else {
      console.log('RESULT: One or both rows are missing.');
      if (!user) console.log('- User row missing.');
      if (staff.length === 0) console.log('- Staff row missing.');
    }
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

checkUser();
