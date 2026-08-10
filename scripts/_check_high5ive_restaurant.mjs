import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'

function readEnvVar(file, key) {
  const content = fs.readFileSync(file, 'utf8')
  const line = content.split('\n').find(l => l.startsWith(`${key}=`))
  if (!line) return null
  return line.slice(key.length + 1).trim().replace(/^"|"$/g, '')
}

const url = readEnvVar('.env.local', 'DATABASE_URL')
const prisma = new PrismaClient({ datasources: { db: { url } } })

const email = 'high5ive@management.com'

const user = await prisma.user.findUnique({ where: { email } })
console.log('User:', { id: user.id, role: user.role, isActive: user.isActive })

const restaurant = await prisma.restaurant.findFirst({
  where: { OR: [{ managerId: user.id }, { ownerId: user.id }] },
})

if (!restaurant) {
  console.log('NO RESTAURANT linked via managerId/ownerId for this user')
} else {
  console.log('Restaurant:', {
    id: restaurant.id,
    name: restaurant.name,
    ownerId: restaurant.ownerId,
    managerId: restaurant.managerId,
    licenseActive: restaurant.licenseActive,
    licenseExpiry: restaurant.licenseExpiry,
    deletedAt: restaurant.deletedAt,
    createdAt: restaurant.createdAt,
  })
}

await prisma.$disconnect()
