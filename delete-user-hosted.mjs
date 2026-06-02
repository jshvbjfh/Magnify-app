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

    // Soft-delete the staff row (update isDeleted and deletedAt)
    // Note: Assuming columns are "isDeleted" and "deletedAt" based on typical soft-delete patterns.
    // I will check if they exist first or just try to update if columns are common.
    // Actually, I should probably check the schema or use a generic update if I'm not sure,
    // but the prompt says "soft-delete".
    
    const staffUpdate = await prisma.staff.updateMany({
      where: { 
        username: email,
        OR: [
          { isDeleted: false },
          { isDeleted: null }
        ]
      },
      data: {
        isDeleted: true,
        deletedAt: new Date()
      }
    });
    console.log(`Soft-deleted ${staffUpdate.count} staff row(s).`);

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
