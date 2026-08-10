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

const dump = {}
dump.category = await prisma.category.findMany({ where: { OR: [{ restaurantId }, { restaurantId: null }] } })
dump.account = await prisma.account.findMany({ where: { OR: [{ restaurantId }, { restaurantId: null }] } })
dump.journalEntry = await prisma.journalEntry.findMany({ where: { restaurantId } })
const journalEntryIds = dump.journalEntry.map(j => j.id)
dump.journalLine = await prisma.journalLine.findMany({ where: { journalEntryId: { in: journalEntryIds } } })

fs.writeFileSync('scripts/_accounting_dump.json', JSON.stringify(dump, null, 2))
for (const [key, rows] of Object.entries(dump)) console.log(key.padEnd(16), rows.length)

await prisma.$disconnect()
