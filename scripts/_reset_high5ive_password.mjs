import { PrismaClient } from '@prisma/client'
import bcryptjs from 'bcryptjs'
const { hash } = bcryptjs
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
const newPassword = '50000000'

const hashed = await hash(newPassword, 12)
const updated = await prisma.user.update({
  where: { email },
  data: { password: hashed },
  select: { id: true, email: true, role: true, isActive: true, updatedAt: true },
})

console.log('Password reset for:', updated)

await prisma.$disconnect()
