import { PrismaClient } from '@prisma/client'
import pkg from 'bcryptjs'
const { hash } = pkg

const prisma = new PrismaClient({ datasources: { db: { url: 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&connect_timeout=30' } } })

const user = await prisma.user.findUnique({
  where: { email: 'chezjohn2owner@gmail.com' },
  select: { id: true, email: true, role: true, password: true }
})
console.log('Owner account:', { ...user, password: user?.password ? '[SET - length: ' + user.password.length + ']' : '[EMPTY]' })

// Reset password to a known value
const newPassword = 'hello@123'
const hashed = await hash(newPassword, 10)
await prisma.user.update({
  where: { email: 'chezjohn2owner@gmail.com' },
  data: { password: hashed }
})
console.log(`Password reset to: ${newPassword}`)

await prisma.$disconnect()
