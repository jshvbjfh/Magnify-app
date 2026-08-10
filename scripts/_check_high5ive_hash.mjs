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

const user = await prisma.user.findUnique({ where: { email: 'high5ive@management.com' } })
console.log({
  passwordLength: user.password.length,
  looksLikeBcrypt: /^\$2[aby]\$\d{2}\$.{53}$/.test(user.password),
  updatedAt: user.updatedAt,
  createdAt: user.createdAt,
})

await prisma.$disconnect()
