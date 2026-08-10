import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'

function readEnvVar(file, key) {
  const content = fs.readFileSync(file, 'utf8')
  const line = content.split('\n').find(l => l.startsWith(`${key}=`))
  if (!line) return null
  return line.slice(key.length + 1).trim().replace(/^"|"$/g, '')
}

const url = readEnvVar('.env.local', 'DATABASE_URL')
console.log('DB host:', url ? new URL(url.replace(/^postgres(ql)?:/, 'http:')).host : '(none)')

const prisma = new PrismaClient({ datasources: { db: { url } } })

const rows = await prisma.$queryRawUnsafe(
  `SELECT migration_name, finished_at, rolled_back_at
   FROM _prisma_migrations
   ORDER BY started_at DESC
   LIMIT 8`
)
console.log('\n=== LAST 8 MIGRATIONS APPLIED ===')
for (const r of rows) {
  console.log(`  ${r.migration_name}  finished=${r.finished_at ? 'yes' : 'NO'}${r.rolled_back_at ? ' ROLLED BACK' : ''}`)
}

const guest = rows.find(r => r.migration_name.includes('guest_count'))
console.log('\nguest_count migration recorded:', guest ? 'YES' : 'NO')

const col = await prisma.$queryRawUnsafe(
  `SELECT column_name, is_nullable, data_type
   FROM information_schema.columns
   WHERE table_name = 'restaurant_orders' AND column_name = 'guestCount'`
)
console.log('guestCount column present:', col.length > 0 ? JSON.stringify(col[0]) : 'NO')

await prisma.$disconnect()
