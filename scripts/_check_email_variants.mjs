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

for (const email of ['high5ive@management.com', 'highfive@management.com']) {
  const user = await prisma.user.findUnique({ where: { email } })
  console.log(email, '->', user ? { id: user.id, role: user.role } : 'NOT FOUND')
}

await prisma.$disconnect()
