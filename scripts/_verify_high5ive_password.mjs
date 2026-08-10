import { PrismaClient } from '@prisma/client'
import bcryptjs from 'bcryptjs'
import fs from 'node:fs'
const { compare } = bcryptjs

function readEnvVar(file, key) {
  const content = fs.readFileSync(file, 'utf8')
  const line = content.split('\n').find(l => l.startsWith(`${key}=`))
  if (!line) return null
  return line.slice(key.length + 1).trim().replace(/^"|"$/g, '')
}

const url = readEnvVar('.env.local', 'DATABASE_URL')
const prisma = new PrismaClient({ datasources: { db: { url } } })

const user = await prisma.user.findUnique({ where: { email: 'high5ive@management.com' } })
console.log('isActive:', user.isActive, 'updatedAt:', user.updatedAt)
console.log('compare("50000000", storedHash) =>', await compare('50000000', user.password))

await prisma.$disconnect()
