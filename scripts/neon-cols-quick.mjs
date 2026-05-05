import pg from 'pg'
const { Client } = pg
const client = new Client({ connectionString: 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&connect_timeout=30' })
await client.connect()
const users = await client.query(`SELECT id, email, role, "restaurantId", "branchId", "createdAt" FROM users ORDER BY "createdAt" DESC`)
console.log(JSON.stringify(users.rows.map(u => ({email: u.email, role: u.role, restaurantId: u.restaurantId, branchId: u.branchId})), null, 2))
await client.end()
