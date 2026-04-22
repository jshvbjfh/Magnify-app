// Diagnostic script: check PostgreSQL cloud database state
import { PrismaClient } from '@prisma/client'

const url = 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require'
const prisma = new PrismaClient({ datasources: { db: { url } } })

async function main() {
  try {
    // 1. Check tables
    const tables = await prisma.$queryRawUnsafe(
      `SELECT table_name::text FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`
    )
    console.log('=== TABLES IN CLOUD DB ===')
    console.log(tables.map(t => t.table_name).join(', ') || '(none)')
    console.log(`Total: ${tables.length}`)

    if (tables.length === 0) {
      console.log('\n*** NO TABLES FOUND - migrations have never been applied! ***')
      return
    }

    // 2. Check _prisma_migrations
    const hasMigrations = tables.some(t => t.table_name === '_prisma_migrations')
    if (hasMigrations) {
      const migrations = await prisma.$queryRawUnsafe(
        `SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 5`
      )
      console.log('\n=== RECENT MIGRATIONS ===')
      migrations.forEach(m => console.log(`  ${m.migration_name} → ${m.finished_at}`))
    }

    // 3. Count key tables
    const counts = {}
    for (const name of ['users', 'restaurants', 'transactions', 'daily_summaries',
      'restaurant_sync_batches', 'restaurant_sync_events', 'sync_outbox',
      'restaurant_orders', 'restaurant_sync_states', 'sync_cursors',
      'dishes', 'dish_sales', 'employees', 'inventory_items']) {
      try {
        const r = await prisma.$queryRawUnsafe(`SELECT count(*)::int as c FROM "${name}"`)
        counts[name] = r[0].c
      } catch {
        counts[name] = '(table missing)'
      }
    }
    console.log('\n=== ROW COUNTS ===')
    Object.entries(counts).forEach(([k, v]) => console.log(`  ${k}: ${v}`))

    // 3b. Check column names for key tables
    for (const tbl of ['restaurants', 'users', 'transactions', 'daily_summaries', 'restaurant_sync_batches', 'restaurant_sync_states']) {
      try {
        const cols = await prisma.$queryRawUnsafe(`SELECT column_name::text FROM information_schema.columns WHERE table_name='${tbl}' ORDER BY ordinal_position`)
        console.log(`\n  ${tbl} columns: ${cols.map(c => c.column_name).join(', ')}`)
      } catch (e) { console.log(`  ${tbl} column query failed: ${e.message}`) }
    }

    // 4. Check restaurants
    try {
      const rcols = await prisma.$queryRawUnsafe(`SELECT column_name::text FROM information_schema.columns WHERE table_name='restaurants' ORDER BY ordinal_position`)
      const colNames = rcols.map(c => c.column_name)
      console.log('\n=== RESTAURANTS (raw) ===')
      const restaurants = await prisma.$queryRawUnsafe(`SELECT * FROM restaurants ORDER BY "createdAt" DESC LIMIT 10`)
      restaurants.forEach(r => console.log(`  `, JSON.stringify(r)))
    } catch (e) { console.log('Restaurant query failed:', e.message) }

    // 5. Check users
    try {
      const users = await prisma.$queryRawUnsafe(`SELECT * FROM users LIMIT 10`)
      console.log('\n=== USERS ===')
      users.forEach(u => console.log(`  `, JSON.stringify({email: u.email, role: u.role, id: u.id})))
    } catch (e) { console.log('User query failed:', e.message) }

    // 6. Check sync batches
    try {
      const batches = await prisma.$queryRawUnsafe(`SELECT * FROM restaurant_sync_batches ORDER BY "receivedAt" DESC LIMIT 10`)
      console.log('\n=== SYNC BATCHES (cloud side) ===')
      batches.forEach(b => console.log(`  batch=${b.batchId} | status=${b.status} | txns=${b.syncedTransactions} | sums=${b.syncedSummaries} | err=${b.errorMessage} | at=${b.receivedAt}`))
      if (batches.length === 0) console.log('  (none)')
    } catch (e) { console.log('SyncBatch query failed:', e.message) }

    // 7. Check transactions  
    try {
      const txns = await prisma.$queryRawUnsafe(
        `SELECT count(*)::int as total, count(*) FILTER (WHERE synced = true)::int as synced, count(*) FILTER (WHERE synced = false)::int as unsynced FROM transactions`
      )
      console.log('\n=== TRANSACTIONS SUMMARY ===')
      console.log(`  total=${txns[0].total} synced=${txns[0].synced} unsynced=${txns[0].unsynced}`)
      
      const recent = await prisma.$queryRawUnsafe(`SELECT * FROM transactions ORDER BY "createdAt" DESC LIMIT 5`)
      console.log('  Recent:')
      recent.forEach(t => console.log(`    ${t.description} | $${t.amount} | type=${t.type} | source=${t.sourceKind} | synced=${t.synced} | date=${t.date}`))
    } catch (e) { console.log('Transaction query failed:', e.message) }

    // 8. Check daily summaries
    try {
      const sums = await prisma.$queryRawUnsafe(`SELECT * FROM daily_summaries ORDER BY date DESC LIMIT 5`)
      console.log('\n=== DAILY SUMMARIES ===')
      sums.forEach(s => console.log(`  date=${s.date} | rev=${s.totalRevenue} | exp=${s.totalExpenses} | profit=${s.profitLoss} | synced=${s.synced}`))
      if (sums.length === 0) console.log('  (none)')
    } catch (e) { console.log('DailySummary query failed:', e.message) }

    // 9. Check sync state
    try {
      const states = await prisma.$queryRawUnsafe(`SELECT * FROM restaurant_sync_states`)
      console.log('\n=== SYNC STATE ===')
      states.forEach(s => console.log(`  `, JSON.stringify(s)))
      if (states.length === 0) console.log('  (none)')
    } catch (e) { console.log('SyncState query failed:', e.message) }

  } finally {
    await prisma.$disconnect()
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
