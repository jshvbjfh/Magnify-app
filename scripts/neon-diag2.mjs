import { neon } from '@neondatabase/serverless'

const sql = neon('postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require')

const r = await sql`SELECT id, name, "ownerId", "syncRestaurantId" FROM "Restaurant"`
console.log('RESTAURANTS:', JSON.stringify(r, null, 2))

const u = await sql`SELECT id, email, role, "restaurantId", "branchId" FROM "User"`
console.log('USERS:', JSON.stringify(u, null, 2))

const b = await sql`SELECT id, name, "restaurantId", "isMain", "isActive" FROM "RestaurantBranch"`
console.log('BRANCHES:', JSON.stringify(b, null, 2))

const t = await sql`SELECT "restaurantId", COUNT(*) as count FROM "Transaction" GROUP BY "restaurantId"`
console.log('TRANSACTIONS PER RESTAURANT:', JSON.stringify(t, null, 2))

const sb = await sql`SELECT "restaurantId", status, "syncedTransactions", "syncedSummaries", "createdAt" FROM "RestaurantSyncBatch" ORDER BY "createdAt" DESC LIMIT 10`
console.log('SYNC BATCHES (last 10):', JSON.stringify(sb, null, 2))

const ob = await sql`SELECT "entityType", COUNT(*) as count FROM "SyncOutbox" GROUP BY "entityType" ORDER BY count DESC`
console.log('OUTBOX ENTITIES:', JSON.stringify(ob, null, 2))

const d = await sql`SELECT id, name, "restaurantId", "branchId" FROM "Dish" LIMIT 10`
console.log('DISHES:', JSON.stringify(d, null, 2))

const i = await sql`SELECT id, name, "restaurantId", "branchId" FROM "InventoryItem" LIMIT 10`
console.log('INVENTORY:', JSON.stringify(i, null, 2))
