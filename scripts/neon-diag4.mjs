import pg from 'pg'
const { Client } = pg
const client = new Client({ connectionString: 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&connect_timeout=30' })
await client.connect()

const REST = 'cmoclcvse0002fqyclnwcxhmw'

const dishes = await client.query(`SELECT id, name, "branchId" FROM dishes WHERE "restaurantId" = $1`, [REST])
console.log('\nDISHES for chez john2:', JSON.stringify(dishes.rows, null, 2))

const inv = await client.query(`SELECT id, name, "branchId", quantity FROM inventory_items WHERE "restaurantId" = $1`, [REST])
console.log('\nINVENTORY for chez john2:', JSON.stringify(inv.rows, null, 2))

const batches = await client.query(`SELECT "restaurantId", status, "syncedTransactions", "syncedSummaries" FROM restaurant_sync_batches ORDER BY "updatedAt" DESC LIMIT 10`)
console.log('\nSYNC BATCHES last 10:', JSON.stringify(batches.rows, null, 2))

const outbox = await client.query(`SELECT "entityType", COUNT(*) as count FROM sync_outbox WHERE "scopeId" = $1 GROUP BY "entityType"`, [REST])
console.log('\nOUTBOX entity counts for chez john2:', JSON.stringify(outbox.rows, null, 2))

const rest = await client.query(`SELECT id, name, "ownerId", "syncRestaurantId" FROM restaurants WHERE id = $1`, [REST])
console.log('\nRESTAURANT row:', JSON.stringify(rest.rows, null, 2))

await client.end()
