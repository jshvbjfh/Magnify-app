import pg from 'pg'
const { Client } = pg
const client = new Client({ connectionString: 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&connect_timeout=30' })
await client.connect()

const txs = await client.query(`SELECT id, "userId", "restaurantId", amount, type FROM transactions WHERE "restaurantId"='cmodfis4i0002raaqaq288m0v'`)
console.log('Axel Pizzeria transactions:', JSON.stringify(txs.rows, null, 2))

// Check what userId the transaction has
const userRows = await client.query(`SELECT id, email, role FROM users WHERE id=ANY($1::text[])`, [txs.rows.map(r => r.userId)])
console.log('Transaction users:', JSON.stringify(userRows.rows, null, 2))

await client.end()
