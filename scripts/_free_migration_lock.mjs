/**
 * Frees the orphaned Prisma advisory lock that blocks `prisma migrate deploy`,
 * then clears the failed migration record so the (now idempotent) migration can
 * retry on the next deploy.
 *
 * Background: a migration run was killed mid-flight. Its session-level advisory
 * lock (72707369) was never released, so every later `migrate deploy` times out
 * with P1002 before it can run anything — which also fails the whole Vercel
 * build, since the build is `migrate deploy && build:web`.
 *
 * Safe: it only terminates backends that are BOTH idle AND holding that one
 * lock. Active sessions are left alone. Terminated pooled connections reconnect
 * automatically.
 *
 * Run:  node scripts/_free_migration_lock.mjs
 */
import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'

const LOCK_ID = 72707369
const STUCK_MIGRATION = '20260723140000_add_restaurant_history_visible_from'

function readEnvVar(file, key) {
  try {
    const content = fs.readFileSync(file, 'utf8')
    const line = content.split('\n').find((l) => l.startsWith(`${key}=`))
    if (!line) return null
    return line.slice(key.length + 1).trim().replace(/^"|"$/g, '')
  } catch {
    return null
  }
}

const url = readEnvVar('.env.local', 'DATABASE_URL') || readEnvVar('.env', 'DATABASE_URL')
if (!url) {
  console.error('No DATABASE_URL found in .env.local or .env')
  process.exit(1)
}

const prisma = new PrismaClient({ datasources: { db: { url } } })

// Cheapest possible release first: through a pooler this connection may well BE
// the backend still holding the lock, in which case unlocking it needs nobody
// terminated at all. $executeRawUnsafe, not $queryRawUnsafe — the function
// returns void, which the query path cannot deserialize.
await prisma.$executeRawUnsafe('SELECT pg_advisory_unlock_all()')
console.log('Released any advisory locks held by this connection.')

const holders = await prisma.$queryRawUnsafe(
  `SELECT l.pid, a.state, a.application_name
     FROM pg_locks l
     JOIN pg_stat_activity a ON a.pid = l.pid
    WHERE l.locktype = 'advisory' AND l.objid = ${LOCK_ID}`
)

if (holders.length === 0) {
  console.log(`No session is holding advisory lock ${LOCK_ID} — nothing to free.`)
} else {
  console.log('Sessions holding the migration lock:')
  for (const h of holders) console.log(`  pid=${h.pid} state=${h.state} app=${h.application_name}`)

  for (const h of holders) {
    // Only ever terminate an idle holder — never interrupt work in progress.
    if (h.state !== 'idle') {
      console.log(`  SKIPPED pid=${h.pid}: state is "${h.state}", not idle. Re-run once it goes idle.`)
      continue
    }
    await prisma.$queryRawUnsafe(`SELECT pg_terminate_backend(${Number(h.pid)})`)
    console.log(`  terminated idle pid=${h.pid}`)
  }

  await new Promise((r) => setTimeout(r, 2000))
  const still = await prisma.$queryRawUnsafe(
    `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = ${LOCK_ID}`
  )
  console.log(still.length === 0 ? 'LOCK RELEASED' : `STILL HELD by ${still.length} session(s)`)
}

// With the lock gone, clear the failed record so the idempotent migration retries.
const failed = await prisma.$queryRawUnsafe(
  `SELECT migration_name FROM _prisma_migrations
    WHERE migration_name = '${STUCK_MIGRATION}'
      AND finished_at IS NULL AND rolled_back_at IS NULL`
)

if (failed.length === 0) {
  console.log(`\nMigration ${STUCK_MIGRATION} has no unresolved failed record — nothing to clear.`)
} else {
  await prisma.$executeRawUnsafe(
    `UPDATE _prisma_migrations SET rolled_back_at = NOW()
      WHERE migration_name = '${STUCK_MIGRATION}'
        AND finished_at IS NULL AND rolled_back_at IS NULL`
  )
  console.log(`\nMarked ${STUCK_MIGRATION} as rolled back — it will re-apply on the next deploy.`)
}

console.log('\nNext: redeploy on Vercel (or push). The migration is idempotent now, so it will apply cleanly.')

await prisma.$disconnect()
