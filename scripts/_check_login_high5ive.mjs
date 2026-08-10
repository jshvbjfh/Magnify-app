import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

const email = 'high5ive@management.com'

const user = await prisma.user.findUnique({ where: { email } })
if (!user) {
  console.log('NO USER FOUND for', email)
} else {
  console.log({
    id: user.id,
    email: user.email,
    role: user.role,
    isActive: user.isActive,
    isSuperAdmin: user.isSuperAdmin,
    hasPasswordHash: !!user.password,
    passwordHashPrefix: user.password?.slice(0, 7),
  })
}

await prisma.$disconnect()
