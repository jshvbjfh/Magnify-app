/**
 * Recovery: rebuild the _prisma_migrations ledger to match the real schema.
 *
 * The database schema is complete and healthy (all tables + columns present,
 * including the shift feature), but _prisma_migrations was reset to a near-empty
 * state — most likely by a recent DB restore/region move. As a result
 * `migrate deploy` tries to re-run old migrations (baseline: "relation accounts
 * already exists") and every deploy is blocked.
 *
 * Since the schema already reflects every migration, the correct repair is to
 * mark them all as applied without running them (Prisma's baseline flow):
 *   1. delete the stuck/failed baseline row
 *   2. `prisma migrate resolve --applied <name>` for every migration folder that
 *      isn't already recorded as applied
 *
 * `migrate resolve` computes each migration's checksum from its file and inserts
 * the applied row — it runs no SQL against your tables, so it cannot damage data.
 * Runs against the DIRECT (non-pooler) endpoint to avoid the pooler.
 *
 * Run:  node scripts/_baseline_prisma_migrations.mjs
 */
import { PrismaClient } from '@prisma/client'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

function readEnvVar(file, key) {
  const content = readFileSync(file, 'utf8')
  const line = content.split('\n').find((l) => l.startsWith(`${key}=`))
  return line ? line.slice(key.length + 1).trim().replace(/^"|"$/g, '') : null
}

const pooledUrl = readEnvVar('.env.local', 'DATABASE_URL')
// Migrations must not go through pgbouncer — use the direct endpoint.
const directUrl = pooledUrl.replace('-pooler.', '.')

const prisma = new PrismaClient({ datasources: { db: { url: directUrl } } })

const migrationsDir = resolve(process.cwd(), 'prisma', 'postgres', 'migrations')
const schemaPath = resolve(process.cwd(), 'prisma', 'postgres', 'schema.prisma')
const prismaCli = resolve(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js')

const allMigrations = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()

console.log(`Found ${allMigrations.length} migration folders.`)

// 1. Clear any un-finished (failed) row so it doesn't linger.
const failed = await prisma.$executeRawUnsafe(
  `DELETE FROM _prisma_migrations WHERE finished_at IS NULL`,
)
console.log(`Cleared ${failed} un-finished (failed) tracking row(s).`)

// 2. Which are already recorded as applied?
const appliedRows = await prisma.$queryRawUnsafe(
  `SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL`,
)
const alreadyApplied = new Set(appliedRows.map((r) => r.migration_name))
console.log(`Already applied: ${alreadyApplied.size}`)

await prisma.$disconnect()

// 3. Mark every remaining migration as applied (no SQL runs against tables).
const env = { ...process.env, DATABASE_URL: directUrl, PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: 'true' }
let marked = 0
for (const name of allMigrations) {
  if (alreadyApplied.has(name)) {
    console.log(`  skip (already applied) ${name}`)
    continue
  }
  const res = spawnSync(process.execPath, [prismaCli, 'migrate', 'resolve', '--applied', name, '--schema', schemaPath], {
    stdio: 'pipe',
    env,
    encoding: 'utf8',
  })
  if ((res.status ?? 1) !== 0) {
    console.error(`  FAILED to mark ${name}:`, (res.stderr || res.stdout || '').trim().split('\n').pop())
    process.exit(1)
  }
  console.log(`  marked applied  ${name}`)
  marked++
}

console.log(`\nDone. Marked ${marked} migration(s) applied. The next deploy should report "No pending migrations to apply".`)
