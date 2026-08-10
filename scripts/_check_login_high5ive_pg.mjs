import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'

function readEnvVar(file, key) {
  const content = fs.readFileSync(file, 'utf8')
  const line = content.split('\n').find(l => l.startsWith(`${key}=`))
  if (!line) return null
  return line.slice(key.length + 1).trim().replace(/^"|"$/g, '')
}

const url = readEnvVar('.env.local', 'DATABASE_URL')
if (!url) {
  console.log('No DATABASE_URL found in .env.local')
  process.exit(1)
}

const prisma = new PrismaClient({ datasources: { db: { url } } })

const email = 'high5ive@management.com'

try {
  const user = await prisma.user.findUnique({ where: { email } })
  if (!user) {
    console.log('NO USER FOUND (Postgres/Neon) for', email)
  } else {
    console.log({
      id: user.id,
      email: user.email,
      role: user.role,
      isActive: user.isActive,
      isSuperAdmin: user.isSuperAdmin,
      hasPasswordHash: !!user.password,
    })
  }
} catch (e) {
  console.log('ERROR querying Postgres:', e.message)
}

await prisma.$disconnect()
