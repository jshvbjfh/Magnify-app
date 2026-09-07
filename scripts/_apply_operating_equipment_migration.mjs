// Applies ONLY 20260907090000_add_operating_equipment to the live database and
// records it in Prisma's ledger.
//
// Why by hand: the live DB last ran a migration on 2026-08-22, so four RRA
// migrations sit ahead of this one and `migrate deploy` cannot skip them. This
// venue is on the normal (non-fiscal) app, so the RRA schema is deliberately
// left pending rather than shipped as a side effect of a supplies tab.
//
// The ledger row is written in the SAME transaction as the DDL, with the real
// SHA-256 checksum of the migration file — so a later `migrate deploy` sees this
// migration as already applied and does not try it again or flag it as edited.
import { PrismaClient } from '@prisma/client'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'

function readEnvVar(file, key) {
  const content = fs.readFileSync(file, 'utf8')
  const line = content.split('\n').find(l => l.startsWith(`${key}=`))
  return line ? line.slice(key.length + 1).trim().replace(/^"|"$/g, '') : null
}

const MIGRATION = '20260907090000_add_operating_equipment'
const FILE = `prisma/postgres/migrations/${MIGRATION}/migration.sql`
const DRY_RUN = process.argv.includes('--dry-run')

const prisma = new PrismaClient({ datasources: { db: { url: readEnvVar('.env.local', 'DATABASE_URL') } } })

const raw = fs.readFileSync(FILE)
// Prisma checksums the raw bytes of migration.sql, hex-encoded SHA-256.
const checksum = createHash('sha256').update(raw).digest('hex')

const statements = raw.toString('utf8')
  .split(/;\s*$/m)
  .map(s => s.replace(/^\s*--.*$/gm, '').trim())
  .filter(Boolean)

const already = await prisma.$queryRawUnsafe(
  `SELECT migration_name, finished_at FROM _prisma_migrations WHERE migration_name = $1`, MIGRATION)
if (already.length > 0) {
  console.log('Already recorded as applied — nothing to do:', already[0])
  await prisma.$disconnect()
  process.exit(0)
}

const existingTables = await prisma.$queryRawUnsafe(
  `SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'operating%'`)
console.log('Migration :', MIGRATION)
console.log('Checksum  :', checksum)
console.log('Statements:', statements.length)
console.log('Tables already present:', existingTables.length ? existingTables : 'none')

if (DRY_RUN) {
  console.log('\nDRY RUN — nothing applied.')
  await prisma.$disconnect()
  process.exit(0)
}

await prisma.$transaction(async (tx) => {
  for (const stmt of statements) await tx.$executeRawUnsafe(stmt)

  await tx.$executeRawUnsafe(
    `INSERT INTO _prisma_migrations
       (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
     VALUES ($1, $2, NOW(), $3, NULL, NULL, NOW(), $4)`,
    randomUUID(), checksum, MIGRATION, statements.length)
}, { timeout: 120000, maxWait: 20000 })

console.log('\nApplied and recorded.')

const tables = await prisma.$queryRawUnsafe(
  `SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'operating%' ORDER BY table_name`)
console.log('Tables now present:', tables.map(t => t.table_name).join(', '))
const flag = await prisma.$queryRawUnsafe(
  `SELECT column_name, column_default FROM information_schema.columns
   WHERE table_name='restaurants' AND column_name='operatingEquipmentEnabled'`)
console.log('Restaurant flag  :', flag[0] ?? 'MISSING')
const ledger = await prisma.$queryRawUnsafe(
  `SELECT migration_name, finished_at, applied_steps_count FROM _prisma_migrations
   ORDER BY started_at DESC LIMIT 3`)
console.table(ledger)

await prisma.$disconnect()
