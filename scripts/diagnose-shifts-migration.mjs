// READ-ONLY: why did `migrate deploy` report nothing pending while the
// shiftsEnabled column is still missing? Compares the migration folders on disk
// with the rows recorded in _prisma_migrations.
import fs from 'fs'
import path from 'path'

const env = {}
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/)
  if (m) env[m[1]] = m[2]
}
for (const k of ['DATABASE_URL', 'DIRECT_URL']) if (env[k]) process.env[k] = env[k]

const dir = path.resolve('prisma/migrations')
const folders = fs.readdirSync(dir, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .sort()

console.log(`migration folders on disk: ${folders.length}`)
console.log('last 4:', folders.slice(-4).join('\n           '))

const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()

const rows = await p.$queryRawUnsafe(
  `SELECT migration_name, finished_at, applied_steps_count
     FROM _prisma_migrations ORDER BY migration_name`,
)
const recorded = new Set(rows.map(r => r.migration_name))
console.log(`\nrows in _prisma_migrations: ${rows.length}`)

const missing = folders.filter(f => !recorded.has(f))
console.log(`\nfolders NOT recorded as applied: ${missing.length}`)
for (const m of missing) console.log('  ', m)

const mine = rows.find(r => r.migration_name.includes('shifts_enabled'))
console.log('\nshifts_enabled row:', mine ? JSON.stringify(mine) : 'none')

await p.$disconnect()
