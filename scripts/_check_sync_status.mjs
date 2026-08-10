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

const restaurant = await prisma.restaurant.findFirst({ where: { name: 'High 5ive' } })

const cursors = await prisma.syncCursor.findMany({
  where: { scopeId: restaurant.id },
  orderBy: { lastPulledAt: 'desc' },
})
console.log('Sync cursors for High 5ive:', cursors.map(c => ({ target: c.target, lastPulledAt: c.lastPulledAt, lastPushedAt: c.lastPushedAt })))

await prisma.$disconnect()
