// Diagnostic: check SQLite desktop state using better-sqlite3
import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dbPath = join(__dirname, '..', 'prisma', 'dev.db')
const db = new Database(dbPath, { readonly: true })

function query(sql) { try { return db.prepare(sql).all() } catch(e) { return `ERROR: ${e.message}` } }
function queryOne(sql) { try { return db.prepare(sql).get() } catch(e) { return `ERROR: ${e.message}` } }

console.log('========= SQLITE DESKTOP STATE =========\n')

console.log('=== Users ===')
const users = query(`SELECT id, email, role, name, password IS NOT NULL as hasPassword, restaurantId FROM User`)
if (Array.isArray(users)) users.forEach(u => console.log(`  ${u.email} | role=${u.role} | hasPassword=${u.hasPassword} | restaurant=${u.restaurantId}`))
else console.log(users)

console.log('\n=== Restaurants ===')
const restaurants = query(`SELECT id, name, ownerId, syncRestaurantId, syncToken IS NOT NULL as hasToken FROM Restaurant`)
if (Array.isArray(restaurants)) restaurants.forEach(r => console.log(`  ${r.name} | id=${r.id} | syncId=${r.syncRestaurantId} | hasToken=${r.hasToken} | owner=${r.ownerId}`))
else console.log(restaurants)

console.log('\n=== Transactions ===')
const txnCount = queryOne(`SELECT count(*) as total, SUM(CASE WHEN synced=1 THEN 1 ELSE 0 END) as synced, SUM(CASE WHEN synced=0 THEN 1 ELSE 0 END) as unsynced FROM "Transaction"`)
console.log(`  total=${txnCount.total} synced=${txnCount.synced} unsynced=${txnCount.unsynced}`)

const recentTxns = query(`SELECT id, description, amount, type, sourceKind, synced, date FROM "Transaction" ORDER BY createdAt DESC LIMIT 5`)
if (Array.isArray(recentTxns)) recentTxns.forEach(t => console.log(`  ${t.description} | $${t.amount} | type=${t.type} | source=${t.sourceKind} | synced=${t.synced} | date=${t.date}`))

console.log('\n=== DailySummaries ===')
const sums = query(`SELECT date, totalRevenue, totalExpenses, profitLoss, synced FROM DailySummary ORDER BY date DESC LIMIT 5`)
if (Array.isArray(sums) && sums.length > 0) sums.forEach(s => console.log(`  date=${s.date} | rev=${s.totalRevenue} | exp=${s.totalExpenses} | profit=${s.profitLoss} | synced=${s.synced}`))
else console.log('  (none)')

console.log('\n=== SyncState ===')
const states = query(`SELECT * FROM RestaurantSyncState`)
if (Array.isArray(states) && states.length > 0) states.forEach(s => console.log(`  `, JSON.stringify(s)))
else console.log('  (none)')

console.log('\n=== SyncEvents (last 5) ===')
const events = query(`SELECT * FROM RestaurantSyncEvent ORDER BY createdAt DESC LIMIT 5`)
if (Array.isArray(events) && events.length > 0) events.forEach(e => console.log(`  `, JSON.stringify(e)))
else console.log('  (none)')

console.log('\n=== SyncBatches (last 5) ===')
const batches = query(`SELECT * FROM RestaurantSyncBatch ORDER BY receivedAt DESC LIMIT 5`)
if (Array.isArray(batches) && batches.length > 0) batches.forEach(b => console.log(`  `, JSON.stringify(b)))
else console.log('  (none)')

console.log('\n=== SyncOutbox ===')
const outboxCount = queryOne(`SELECT count(*) as total, SUM(CASE WHEN syncedAt IS NOT NULL THEN 1 ELSE 0 END) as synced, SUM(CASE WHEN syncedAt IS NULL THEN 1 ELSE 0 END) as pending FROM SyncOutbox`)
console.log(`  total=${outboxCount.total} synced=${outboxCount.synced} pending=${outboxCount.pending}`)

const pendingOutbox = query(`SELECT entityType, operation, attempts, lastError, syncedAt FROM SyncOutbox WHERE syncedAt IS NULL ORDER BY createdAt DESC LIMIT 10`)
if (Array.isArray(pendingOutbox) && pendingOutbox.length > 0) {
  console.log('  Pending samples:')
  pendingOutbox.forEach(o => console.log(`    type=${o.entityType} | op=${o.operation} | attempts=${o.attempts} | err=${o.lastError}`))
}

console.log('\n=== SyncCursors ===')
const cursors = query(`SELECT * FROM SyncCursor`)
if (Array.isArray(cursors) && cursors.length > 0) cursors.forEach(c => console.log(`  `, JSON.stringify(c)))
else console.log('  (none)')

console.log('\n=== BranchDevices ===')
const devices = query(`SELECT * FROM BranchDevice`)
if (Array.isArray(devices) && devices.length > 0) devices.forEach(d => console.log(`  `, JSON.stringify(d)))
else console.log('  (none)')

console.log('\n=== Restaurant Orders ===')
const orders = queryOne(`SELECT count(*) as c FROM RestaurantOrder`)
console.log(`  count=${orders.c}`)

console.log('\n=== DishSales ===')
const sales = queryOne(`SELECT count(*) as c FROM DishSale`)
console.log(`  count=${sales.c}`)

console.log('\n=== Dishes ===')
const dishes = queryOne(`SELECT count(*) as c FROM Dish`)
console.log(`  count=${dishes.c}`)

console.log('\n=== Employees ===')
const emps = queryOne(`SELECT count(*) as c FROM Employee`)
console.log(`  count=${emps.c}`)

console.log('\n=== InventoryItems ===')
const invItems = queryOne(`SELECT count(*) as c FROM InventoryItem`)
console.log(`  count=${invItems.c}`)

db.close()
