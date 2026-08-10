import { PrismaClient } from '@prisma/client'
import bcryptjs from 'bcryptjs'
const { compare } = bcryptjs

const dbPath = 'C:/Users/HP/AppData/Roaming/restaurant-app/data/dev.db'
const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } })

const email = 'high5ive@management.com'
try {
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) {
    console.log('NO USER in local desktop db for', email)
  } else {
    console.log({
      id: user.id,
      role: user.role,
      isActive: user.isActive,
      updatedAt: user.updatedAt,
      matchesNewPassword: await compare('50000000', user.password),
    })
  }
} catch (e) {
  console.log('ERROR:', e.message)
}

await prisma.$disconnect()
