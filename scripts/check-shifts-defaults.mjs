// READ-ONLY: confirm the shiftsEnabled backfill left every existing restaurant
// on the old behaviour (shifts ON), so the migration changed nothing for anyone.
import fs from 'fs'

const env = {}
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/)
  if (m) env[m[1]] = m[2]
}
for (const k of ['DATABASE_URL', 'DIRECT_URL']) if (env[k]) process.env[k] = env[k]

const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()

const rows = await p.restaurant.findMany({
  where: { deletedAt: null },
  select: { name: true, shiftsEnabled: true },
  orderBy: { name: 'asc' },
})
console.log(`restaurants: ${rows.length}`)
for (const r of rows) console.log(`  ${r.shiftsEnabled ? 'shifts ON ' : 'shifts OFF'}  ${r.name}`)
console.log(`\nany switched off by the migration: ${rows.filter(r => !r.shiftsEnabled).length}`)

await p.$disconnect()
