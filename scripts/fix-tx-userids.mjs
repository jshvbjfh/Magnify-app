import pg from 'pg'
const { Client } = pg
const client = new Client({ connectionString: 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&connect_timeout=30' })
await client.connect()

// Fix all transactions for Axel Pizzeria to use ownerId (axel2004@gmail.com = cmodira4m0003f3gqohngg89z)
const result = await client.query(
  `UPDATE transactions SET "userId"='cmodira4m0003f3gqohngg89z' WHERE "restaurantId"='cmodfis4i0002raaqaq288m0v' RETURNING id, "userId", amount`
)
console.log('Fixed transactions:', JSON.stringify(result.rows, null, 2))

// Also fix daily summaries
const summaryResult = await client.query(
  `UPDATE daily_summaries SET "userId"='cmodira4m0003f3gqohngg89z' WHERE "restaurantId"='cmodfis4i0002raaqaq288m0v' RETURNING id, "userId"`
)
console.log('Fixed summaries:', JSON.stringify(summaryResult.rows, null, 2))

// Similarly fix for chezjohn2 - all transactions should use the ownerId
// chezjohn2 restaurant owner is chezjohn2owner@gmail.com = cmoco8mrx0001d1mo8dkly9yy
// but ownerId on the restaurant should be checked
const chezOwner = await client.query(`SELECT "ownerId" FROM restaurants WHERE id='cmoclcvse0002fqyclnwcxhmw'`)
console.log('\nChezjohn2 restaurant ownerId:', chezOwner.rows[0])

await client.end()
