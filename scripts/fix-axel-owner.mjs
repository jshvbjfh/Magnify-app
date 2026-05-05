import pg from 'pg'
const { Client } = pg
const client = new Client({ connectionString: 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&connect_timeout=30' })
await client.connect()

const restId = 'cmodfis4i0002raaqaq288m0v'
const axelOwnerId = 'cmodira4m0003f3gqohngg89z' // axel2004@gmail.com (role: owner)

// Fix: set ownerId to axel2004@gmail.com
const result = await client.query(
  `UPDATE restaurants SET "ownerId"=$1 WHERE id=$2 RETURNING id, name, "ownerId"`,
  [axelOwnerId, restId]
)
console.log('Fixed restaurant ownerId:', JSON.stringify(result.rows[0], null, 2))

// Verify transactions in Neon for Axel Pizzeria
const txs = await client.query(`SELECT id, amount, type, description, "createdAt" FROM transactions WHERE "restaurantId"=$1 ORDER BY "createdAt" DESC LIMIT 10`, [restId])
console.log('\nTransactions in Neon for Axel Pizzeria:', JSON.stringify(txs.rows, null, 2))

await client.end()
