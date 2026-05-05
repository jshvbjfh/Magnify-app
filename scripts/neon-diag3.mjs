import pg from 'pg'
const { Client } = pg

const client = new Client({
  connectionString: 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&connect_timeout=30'
})

async function q(label, query) {
  const res = await client.query(query)
  console.log(`\n=== ${label} ===`)
  console.table(res.rows)
}

await client.connect();

await q('RESTAURANTS', 'SELECT id, name, "ownerId", "syncRestaurantId" IS NOT NULL as has_sync_id FROM restaurants')
await q('USERS', 'SELECT id, email, role, "restaurantId", "branchId" FROM users')
await q('BRANCHES', 'SELECT id, name, "restaurantId", "isMain", "isActive" FROM restaurant_branches')
await q('TRANSACTIONS PER RESTAURANT', 'SELECT "restaurantId", COUNT(*) as count FROM transactions GROUP BY "restaurantId"')
await q('SYNC BATCHES last 10', 'SELECT "restaurantId", status, "syncedTransactions", "syncedSummaries" FROM restaurant_sync_batches ORDER BY "createdAt" DESC LIMIT 10')
await q('OUTBOX ENTITY COUNTS', 'SELECT "entityType", COUNT(*) as count FROM sync_outbox GROUP BY "entityType" ORDER BY count DESC')
await q('DISHES IN NEON', 'SELECT id, name, "restaurantId", "branchId" FROM dishes LIMIT 10')
await q('INVENTORY IN NEON', 'SELECT id, name, "restaurantId", "branchId" FROM inventory_items LIMIT 10')

await client.end()
