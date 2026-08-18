// Clears sync_outbox rows for SIROCCO Y SOL whose inventoryBatchUsageLedger
// entity no longer exists — left behind when the test sale that created the
// ledger row was purged. Dry run unless --execute.
import fs from 'fs'

const EXECUTE = process.argv.includes('--execute')
const env = {}
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/)
  if (m) env[m[1]] = m[2]
}
for (const k of ['DATABASE_URL', 'DIRECT_URL']) if (env[k]) process.env[k] = env[k]

const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const RID = 'cmssn2wif000210rcxlzs1jny'

const rows = await p.syncOutbox.findMany({
  where: { restaurantId: RID, entityType: 'inventoryBatchUsageLedger' },
  select: { id: true, entityId: true, operation: true, syncedAt: true },
})

const orphans = []
for (const row of rows) {
  const exists = await p.inventoryBatchUsageLedger.findUnique({ where: { id: row.entityId }, select: { id: true } })
  if (!exists) orphans.push(row)
}

console.log(`ledger outbox rows: ${rows.length}, orphaned: ${orphans.length}`)
for (const o of orphans) console.log(`  ${o.entityId}  op=${o.operation}  synced=${o.syncedAt ? 'yes' : 'no'}`)

if (!EXECUTE) {
  console.log('Dry run — re-run with --execute to delete.')
} else if (orphans.length) {
  const res = await p.syncOutbox.deleteMany({ where: { id: { in: orphans.map(o => o.id) } } })
  console.log(`deleted ${res.count} orphan outbox rows`)
}

await p.$disconnect()
