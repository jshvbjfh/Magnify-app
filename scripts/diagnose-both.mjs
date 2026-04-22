// Diagnostic: check Acme2 owner in cloud + SQLite desktop state
import { PrismaClient } from '@prisma/client'

const cloudUrl = 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require'

async function checkCloud() {
  const prisma = new PrismaClient({ datasources: { db: { url: cloudUrl } } })
  try {
    console.log('=== CLOUD: Acme2 owner user ===')
    const acme2Owner = await prisma.$queryRawUnsafe(
      `SELECT id, email, role, name, password IS NOT NULL as "hasPassword", "restaurantId" FROM users WHERE id = 'cmnqpkwnl000011d37sn2wcma'`
    )
    console.log(JSON.stringify(acme2Owner, null, 2))

    // Also check if there are duplicate restaurants for Acme2
    console.log('\n=== CLOUD: Acme2 restaurants ===')
    const acme2Restaurants = await prisma.$queryRawUnsafe(
      `SELECT id, name, "ownerId", "syncRestaurantId", "syncToken" IS NOT NULL as "hasToken" FROM restaurants WHERE "ownerId" = 'cmnqpkwnl000011d37sn2wcma'`
    )
    console.log(JSON.stringify(acme2Restaurants, null, 2))

    // Check transactions for Acme2
    console.log('\n=== CLOUD: Acme2 transactions ===')
    const acme2Txns = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int as total, count(*) FILTER (WHERE "sourceKind" = 'cloud_sync')::int as from_sync, count(*) FILTER (WHERE synced)::int as synced FROM transactions WHERE "restaurantId" IN (SELECT id FROM restaurants WHERE "ownerId" = 'cmnqpkwnl000011d37sn2wcma')`
    )
    console.log(JSON.stringify(acme2Txns, null, 2))

    // Check any waiter/owner accounts for Acme2
    console.log('\n=== CLOUD: Users linked to Acme2 restaurant ===')
    const linkedUsers = await prisma.$queryRawUnsafe(
      `SELECT id, email, role, name, password IS NOT NULL as "hasPassword" FROM users WHERE "restaurantId" IN (SELECT id FROM restaurants WHERE "ownerId" = 'cmnqpkwnl000011d37sn2wcma')`
    )
    console.log(JSON.stringify(linkedUsers, null, 2))

  } finally {
    await prisma.$disconnect()
  }
}

async function checkSqlite() {
  const prisma = new PrismaClient({ datasources: { db: { url: 'file:./dev.db' } } })
  try {
    console.log('\n\n========= SQLITE DESKTOP =========')

    // 1. Users
    console.log('=== SQLITE: Users ===')
    const users = await prisma.$queryRawUnsafe(`SELECT id, email, role, name, password IS NOT NULL as hasPassword, restaurantId FROM User`)
    users.forEach(u => console.log(`  ${u.email} | role=${u.role} | hasPassword=${u.hasPassword} | restaurant=${u.restaurantId}`))

    // 2. Restaurant
    console.log('\n=== SQLITE: Restaurants ===')
    const restaurants = await prisma.$queryRawUnsafe(`SELECT id, name, ownerId, syncRestaurantId, syncToken IS NOT NULL as hasToken FROM Restaurant`)
    restaurants.forEach(r => console.log(`  ${r.name} | id=${r.id} | syncId=${r.syncRestaurantId} | hasToken=${r.hasToken} | owner=${r.ownerId}`))

    // 3. Transactions
    console.log('\n=== SQLITE: Transactions ===')
    const txnCount = await prisma.$queryRawUnsafe(`SELECT count(*) as total, SUM(CASE WHEN synced=1 THEN 1 ELSE 0 END) as synced, SUM(CASE WHEN synced=0 THEN 1 ELSE 0 END) as unsynced FROM "Transaction"`)
    console.log(`  total=${txnCount[0].total} synced=${txnCount[0].synced} unsynced=${txnCount[0].unsynced}`)

    // 4. Daily summaries
    console.log('\n=== SQLITE: DailySummaries ===')
    const sums = await prisma.$queryRawUnsafe(`SELECT date, totalRevenue, totalExpenses, profitLoss, synced FROM DailySummary ORDER BY date DESC LIMIT 5`)
    sums.forEach(s => console.log(`  date=${s.date} | rev=${s.totalRevenue} | exp=${s.totalExpenses} | profit=${s.profitLoss} | synced=${s.synced}`))
    if (sums.length === 0) console.log('  (none)')

    // 5. Sync state
    console.log('\n=== SQLITE: SyncState ===')
    const states = await prisma.$queryRawUnsafe(`SELECT * FROM RestaurantSyncState`)
    states.forEach(s => console.log(`  `, JSON.stringify(s)))
    if (states.length === 0) console.log('  (none)')

    // 6. Sync events
    console.log('\n=== SQLITE: SyncEvents ===')
    const events = await prisma.$queryRawUnsafe(`SELECT * FROM RestaurantSyncEvent ORDER BY createdAt DESC LIMIT 5`)
    events.forEach(e => console.log(`  `, JSON.stringify(e)))
    if (events.length === 0) console.log('  (none)')

    // 7. Sync batches
    console.log('\n=== SQLITE: SyncBatches ===')
    const batches = await prisma.$queryRawUnsafe(`SELECT * FROM RestaurantSyncBatch ORDER BY receivedAt DESC LIMIT 5`)
    batches.forEach(b => console.log(`  `, JSON.stringify(b)))
    if (batches.length === 0) console.log('  (none)')

    // 8. Sync outbox
    console.log('\n=== SQLITE: SyncOutbox ===')
    const outbox = await prisma.$queryRawUnsafe(`SELECT count(*) as total, SUM(CASE WHEN syncedAt IS NOT NULL THEN 1 ELSE 0 END) as synced, SUM(CASE WHEN syncedAt IS NULL THEN 1 ELSE 0 END) as pending FROM SyncOutbox`)
    console.log(`  total=${outbox[0].total} synced=${outbox[0].synced} pending=${outbox[0].pending}`)

    const pendingOutbox = await prisma.$queryRawUnsafe(`SELECT entityType, operation, attempts, lastError, syncedAt FROM SyncOutbox WHERE syncedAt IS NULL ORDER BY createdAt DESC LIMIT 10`)
    console.log('  Pending samples:')
    pendingOutbox.forEach(o => console.log(`    type=${o.entityType} | op=${o.operation} | attempts=${o.attempts} | err=${o.lastError}`))

    // 9. Sync cursors
    console.log('\n=== SQLITE: SyncCursors ===')
    const cursors = await prisma.$queryRawUnsafe(`SELECT * FROM SyncCursor`)
    cursors.forEach(c => console.log(`  `, JSON.stringify(c)))
    if (cursors.length === 0) console.log('  (none)')

    // 10. Branch device
    console.log('\n=== SQLITE: BranchDevices ===')
    const devices = await prisma.$queryRawUnsafe(`SELECT * FROM BranchDevice`)
    devices.forEach(d => console.log(`  `, JSON.stringify(d)))
    if (devices.length === 0) console.log('  (none)')

    // 11. Orders count
    console.log('\n=== SQLITE: Orders ===')
    const orders = await prisma.$queryRawUnsafe(`SELECT count(*) as c FROM RestaurantOrder`)
    console.log(`  count=${orders[0].c}`)

    // 12. DishSales
    console.log('\n=== SQLITE: DishSales ===')
    const sales = await prisma.$queryRawUnsafe(`SELECT count(*) as c FROM DishSale`)
    console.log(`  count=${sales[0].c}`)

  } finally {
    await prisma.$disconnect()
  }
}

checkCloud().then(() => checkSqlite()).catch(e => { console.error('FATAL:', e.message); process.exit(1) })
