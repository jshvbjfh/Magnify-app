import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient({ datasources: { db: { url: 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&connect_timeout=30' } } })

const user = await prisma.user.findUnique({
  where: { email: 'chezjohn2owner@gmail.com' },
  select: { id: true, email: true, role: true, password: true, passwordHash: true }
})
console.log('Owner account:', JSON.stringify({ ...user, password: user?.password ? '[SET]' : null, passwordHash: user?.passwordHash ? '[SET]' : null }, null, 2))

await prisma.$disconnect()
