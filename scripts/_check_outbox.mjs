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

const totalOutbox = await prisma.syncOutbox.count({ where: { scopeId: restaurant.id } })
const byEntityType = await prisma.syncOutbox.groupBy({
  by: ['entityType'],
  where: { scopeId: restaurant.id },
  _count: true,
})

console.log('Restaurant:', restaurant.id)
console.log('Total outbox rows for this restaurant:', totalOutbox)
console.log('By entity type:', byEntityType)

await prisma.$disconnect()
