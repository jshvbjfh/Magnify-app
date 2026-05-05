import pg from 'pg'
const { Client } = pg
const client = new Client({ connectionString: 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&connect_timeout=30' })
await client.connect()

const REST = 'cmoclcvse0002fqyclnwcxhmw'
const SYNC_ID = 'branch_b00fae69cb3529d7f390'

// Has chez john2 ever synced?
const batches = await client.query(
  `SELECT COUNT(*) as count FROM restaurant_sync_batches WHERE "restaurantId" = $1`, [REST])
console.log('\nTotal sync batches for chez john2:', batches.rows[0].count)

// Any restaurant with this syncRestaurantId?
const restBySyncId = await client.query(
  `SELECT id, name, "syncRestaurantId" FROM restaurants WHERE "syncRestaurantId" = $1`, [SYNC_ID])
console.log('\nRestaurant with syncRestaurantId=branch_b00fae69cb3529d7f390:', JSON.stringify(restBySyncId.rows))

// Any ghost restaurant (different restaurant created by sync for chez john2 credentials)?
// Check all restaurants with no ownerId set or that chezjohn2 admin might have created
const allRests = await client.query(
  `SELECT id, name, "ownerId", "syncRestaurantId" FROM restaurants ORDER BY id DESC LIMIT 20`)
console.log('\nAll restaurants (newest first):', JSON.stringify(allRests.rows, null, 2))

// Check local SQLite db exists
const fs = await import('fs')
const dbPath = 'C:\\Users\\HP\\AppData\\Roaming\\restaurant-app\\data\\dev.db'
console.log('\nLocal SQLite exists:', fs.existsSync(dbPath))

await client.end()
