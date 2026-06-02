import { PrismaClient } from '@prisma/client';

async function performDeletion() {
  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: "postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
      },
    },
  });

  try {
    const email = 'hosted.waiter.0521@gmail.com';
    console.log(`Processing deletion for: ${email}`);

    // Update isActive to false to "soft-delete" based on the available schema fields
    const staffUpdate = await prisma.staff.updateMany({
      where: { 
        username: email,
        isActive: true
      },
      data: {
        isActive: false
      }
    });
    console.log(`Soft-deleted (isActive: false) ${staffUpdate.count} staff row(s).`);

    // Delete the user row
    const userDelete = await prisma.user.deleteMany({
      where: { email: email }
    });
    console.log(`Deleted ${userDelete.count} user row(s).`);

  } catch (error) {
    console.error('Error occurred:', error);
  } finally {
    await prisma.$disconnect();
  }
}

performDeletion();
