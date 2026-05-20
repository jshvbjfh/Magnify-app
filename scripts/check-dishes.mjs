import pkg from '../node_modules/@prisma/client/index.js'
const { PrismaClient } = pkg

process.env.DATABASE_URL = 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require'

const prisma = new PrismaClient()

try {
  // 1. Check current state of the 3 affected admins
  const affected = await prisma.$queryRaw`
    SELECT id, email, role, "restaurantId", "branchId"
    FROM users
    WHERE email IN ('gaelpizzeria@gmail.com','dadpizzeria@gmail.com','jessepizzeria@gmail.com')
  `
  console.log('Affected admins current state:', JSON.stringify(affected, null, 2))

  // 2. Show all null-restaurantId admins/owners
  const broken = await prisma.$queryRaw`
    SELECT id, email, role, "restaurantId", "branchId"
    FROM users
    WHERE "restaurantId" IS NULL AND role IN ('admin','owner')
  `
  console.log('All null-restaurantId admins/owners:', JSON.stringify(broken, null, 2))
} catch (e) {
  console.error('ERROR:', e.message)
} finally {
  await prisma['$disconnect']()
}
