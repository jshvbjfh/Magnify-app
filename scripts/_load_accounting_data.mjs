import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'

const dbPath = 'C:/Users/HP/AppData/Roaming/restaurant-app/data/dev.db'
const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } })

const dump = JSON.parse(fs.readFileSync('scripts/_accounting_dump.json', 'utf8'))

function toDate(v) {
  return v ? new Date(v) : null
}
function convertDates(row, dateFields) {
  const out = { ...row }
  for (const f of dateFields) if (f in out) out[f] = toDate(out[f])
  return out
}
async function upsertAll(model, rows, dateFields) {
  let count = 0
  for (const raw of rows) {
    const row = convertDates(raw, dateFields)
    await prisma[model].upsert({ where: { id: row.id }, update: row, create: row })
    count += 1
  }
  console.log(model.padEnd(16), count)
}

await upsertAll('category', dump.category, ['createdAt', 'updatedAt'])
await upsertAll('account', dump.account, ['createdAt', 'updatedAt'])
await upsertAll('journalEntry', dump.journalEntry, ['entryDate', 'createdAt', 'updatedAt', 'deletedAt'])
await upsertAll('journalLine', dump.journalLine, ['createdAt', 'updatedAt'])

await prisma.$disconnect()
console.log('\nDone.')
