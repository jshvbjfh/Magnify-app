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

console.log('=== INDEXES ON restaurant_orders (live) ===')
const idx = await prisma.$queryRawUnsafe(
  `SELECT indexname FROM pg_indexes WHERE tablename = 'restaurant_orders' ORDER BY indexname`
)
for (const r of idx) console.log('  ' + r.indexname)

console.log('\n=== MIGRATION STATE ===')
const applied = await prisma.$queryRawUnsafe(
  `SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 4`
)
for (const r of applied) console.log(`  ${r.migration_name}  ${r.finished_at ? 'applied' : 'UNFINISHED'}`)

const hasNew = idx.some(r => r.indexname.includes('status_businessDate'))
console.log('\nnew index already present on live DB:', hasNew ? 'YES' : 'NO (migration is pending)')

await prisma.$disconnect()
