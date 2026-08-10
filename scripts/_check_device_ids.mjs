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
const byDevice = await prisma.syncOutbox.groupBy({
  by: ['sourceDeviceId'],
  where: { scopeId: restaurantId },
  _count: true,
})
console.log('Rows by sourceDeviceId:', byDevice)

const cursors = await prisma.syncCursor.findMany({ where: { scopeId: restaurantId } })
console.log('Cloud-side SyncCursor rows for this restaurant:', cursors)

await prisma.$disconnect()
