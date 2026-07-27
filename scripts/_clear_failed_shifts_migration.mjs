/**
 * Recovery: clear the FAILED 20260727120000_add_shifts migration rows so the
 * corrected migration can re-apply.
 *
 * The first attempt failed on `CREATE INDEX ... ON shifts("status")` because a
 * legacy, empty "shifts" table (a different, wage-shaped table) already squatted
 * that name — CREATE TABLE IF NOT EXISTS skipped, then the index hit a table
 * with no status column. That left the migration recorded as failed
 * (finished_at IS NULL), which blocks EVERY later deploy with P3009.
 *
 * The corrected migration creates `service_shifts` instead, so it no longer
 * collides. Nothing from the failed run actually landed (it died before the
 * ADD COLUMNs), so deleting the failed tracking rows is enough — migrate deploy
 * then re-applies the corrected migration from clean.
 *
 * Run:  node scripts/_clear_failed_shifts_migration.mjs
 */
import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'

function readEnvVar(file, key) {
  const content = fs.readFileSync(file, 'utf8')
  const line = content.split('\n').find((l) => l.startsWith(`${key}=`))
  return line ? line.slice(key.length + 1).trim().replace(/^"|"$/g, '') : null
}

const prisma = new PrismaClient({
  datasources: { db: { url: readEnvVar('.env.local', 'DATABASE_URL') } },
})

const NAME = '20260727120000_add_shifts'

const rows = await prisma.$queryRawUnsafe(
  `SELECT started_at, finished_at, rolled_back_at FROM _prisma_migrations WHERE migration_name = '${NAME}'`,
)
console.log(`Found ${rows.length} tracking row(s) for ${NAME}:`)
for (const r of rows) console.log('  started:', r.started_at, '| finished:', r.finished_at, '| rolledback:', r.rolled_back_at)

const anyFinished = rows.some((r) => r.finished_at)
if (anyFinished) {
  console.log('\nABORT — a row is marked finished; this is not the failed state expected. No changes made.')
  process.exit(1)
}

// Also make sure the failed run really did not create anything.
const svc = await prisma.$queryRawUnsafe(
  `SELECT count(*)::int c FROM information_schema.tables WHERE table_name = 'service_shifts'`,
)
console.log('\nservice_shifts table currently exists?', svc[0].c > 0, '(fine either way — migration is idempotent)')

const deleted = await prisma.$executeRawUnsafe(
  `DELETE FROM _prisma_migrations WHERE migration_name = '${NAME}' AND finished_at IS NULL`,
)
console.log(`\nDeleted ${deleted} failed tracking row(s). The next deploy will re-apply the corrected migration.`)

await prisma.$disconnect()
