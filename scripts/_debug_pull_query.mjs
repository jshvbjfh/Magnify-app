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

const restaurantId = 'cmqia7buf0003n5p19gkoov3k'
const GLOBAL_SYNC_SCOPE_ID = 'global' // guessing; will verify separately

const rows = await prisma.syncOutbox.findMany({
  where: {
    OR: [
      { scopeId: restaurantId },
      { scopeId: GLOBAL_SYNC_SCOPE_ID },
    ],
  },
  take: 5,
  orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
})
console.log('Sample rows with guessed GLOBAL scope:', rows.length)

// Try without the OR at all, just scopeId match
const rows2 = await prisma.syncOutbox.findMany({
  where: { scopeId: restaurantId },
  take: 5,
  orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
})
console.log('Sample rows scopeId=restaurantId only:', rows2.length)
if (rows2[0]) console.log('Sample row:', JSON.stringify(rows2[0], null, 2))

await prisma.$disconnect()
