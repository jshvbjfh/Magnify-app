import pg from 'pg'
const { Client } = pg
const client = new Client({ connectionString: 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&connect_timeout=30' })
await client.connect()

// Axel Pizzeria in Neon
const rest = await client.query(`SELECT id, name, "ownerId", "syncRestaurantId", "syncToken" FROM restaurants WHERE "syncRestaurantId"='branch_abebdba70f480bcca3b1'`)
console.log('Axel Pizzeria Neon:', JSON.stringify(rest.rows[0], null, 2))

const neonRestId = rest.rows[0]?.id
if (neonRestId) {
  const users = await client.query(`SELECT id, email, role, "restaurantId" FROM users WHERE "restaurantId"=$1`, [neonRestId])
  console.log('Neon users for Axel Pizzeria:', JSON.stringify(users.rows, null, 2))
}

await client.end()
