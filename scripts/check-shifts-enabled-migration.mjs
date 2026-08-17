// READ-ONLY pre-migration check for the shiftsEnabled column. Confirms the live
// Neon DB's migration history is clean and reports whether the column already
// exists, so the deploy is never run blind.
import fs from 'fs'

const env = {}
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/)
  if (m) env[m[1]] = m[2]
}
for (const k of ['DATABASE_URL', 'DIRECT_URL']) if (env[k]) process.env[k] = env[k]

const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
console.log('DB host:', (process.env.DATABASE_URL || '').match(/@([^/:?]+)/)?.[1] ?? '(none)', '\n')

const col = await p.$queryRawUnsafe(
  `SELECT column_name, data_type, column_default, is_nullable
     FROM information_schema.columns
    WHERE table_name = 'restaurants' AND column_name = 'shiftsEnabled'`,
)
console.log('shiftsEnabled column:', col.length ? JSON.stringify(col[0]) : 'NOT PRESENT — migration needed')

const failed = await p.$queryRawUnsafe(
  `SELECT migration_name, started_at, finished_at, rolled_back_at, applied_steps_count
     FROM _prisma_migrations
    WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL
    ORDER BY started_at DESC`,
)
console.log(`\nfailed / unfinished migrations: ${failed.length}`)
for (const f of failed) console.log('  ', JSON.stringify(f))

const last = await p.$queryRawUnsafe(
  `SELECT migration_name, finished_at FROM _prisma_migrations
    ORDER BY finished_at DESC NULLS FIRST LIMIT 5`,
)
console.log('\nlast applied migrations:')
for (const m of last) console.log('  ', m.migration_name, '→', m.finished_at)

await p.$disconnect()
