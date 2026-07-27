/**
 * Step 1 of applying the shift feature safely: remove the 10 duplicate FAILED
 * rows from _prisma_migrations.
 *
 * Each of these failed rows (applied_steps_count = 0, so they ran no SQL) names
 * a migration that ALSO has a successful applied row — they're harmless junk
 * from months of retries. Removing them clears the P3009 block so migrate deploy
 * can apply the one genuinely-pending migration (add_shifts).
 *
 * HARD GUARD: only ever deletes a failed row whose migration_name also has a
 * finished (applied) row. A migration whose ONLY row is failed is never touched
 * — deleting that would make migrate deploy re-run it (the destructive-cascade
 * risk). Data row counts are printed before and after; they must be identical.
 *
 * Runs against the DIRECT (non-pooler) endpoint. Read the counts carefully.
 */
import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'

function readEnvVar(file, key) {
  const c = fs.readFileSync(file, 'utf8')
  const l = c.split('\n').find((x) => x.startsWith(`${key}=`))
  return l ? l.slice(key.length + 1).trim().replace(/^"|"$/g, '') : null
}

const direct = readEnvVar('.env.local', 'DATABASE_URL').replace('-pooler.', '.')
const prisma = new PrismaClient({ datasources: { db: { url: direct } } })
const q = (s) => prisma.$queryRawUnsafe(s)

const before = {
  restaurants: (await q('SELECT count(*)::int c FROM restaurants'))[0].c,
  orders: (await q('SELECT count(*)::int c FROM restaurant_orders'))[0].c,
  dishSales: (await q('SELECT count(*)::int c FROM dish_sales'))[0].c,
  inventory: (await q('SELECT count(*)::int c FROM inventory_items'))[0].c,
}
console.log('DATA BEFORE:', JSON.stringify(before))

const failedBefore = (await q('SELECT count(*)::int c FROM _prisma_migrations WHERE finished_at IS NULL'))[0].c
const appliedBefore = (await q('SELECT count(*)::int c FROM _prisma_migrations WHERE finished_at IS NOT NULL'))[0].c
console.log('LEDGER BEFORE: applied', appliedBefore, '| failed', failedBefore)

// Guarded delete: only failed rows whose migration ALSO has an applied row.
const deleted = await prisma.$executeRawUnsafe(`
  DELETE FROM _prisma_migrations f
  WHERE f.finished_at IS NULL
    AND EXISTS (
      SELECT 1 FROM _prisma_migrations a
      WHERE a.migration_name = f.migration_name
        AND a.finished_at IS NOT NULL
    )
`)
console.log('\nDeleted', deleted, 'duplicate failed row(s).')

const failedAfter = (await q('SELECT count(*)::int c FROM _prisma_migrations WHERE finished_at IS NULL'))[0].c
const appliedAfter = (await q('SELECT count(*)::int c FROM _prisma_migrations WHERE finished_at IS NOT NULL'))[0].c
console.log('LEDGER AFTER: applied', appliedAfter, '| failed', failedAfter, failedAfter === 0 ? '(clean)' : '(still has non-duplicate failed rows — investigate)')

const after = {
  restaurants: (await q('SELECT count(*)::int c FROM restaurants'))[0].c,
  orders: (await q('SELECT count(*)::int c FROM restaurant_orders'))[0].c,
  dishSales: (await q('SELECT count(*)::int c FROM dish_sales'))[0].c,
  inventory: (await q('SELECT count(*)::int c FROM inventory_items'))[0].c,
}
console.log('DATA AFTER :', JSON.stringify(after))
const dataUnchanged = JSON.stringify(before) === JSON.stringify(after)
console.log('\nDATA UNCHANGED:', dataUnchanged ? 'YES ✓' : '*** NO — STOP, RESTORE FROM HISTORY ***')

await prisma.$disconnect()
