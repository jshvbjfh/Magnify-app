import pg from 'pg'
const { Client } = pg
const client = new Client({ connectionString: 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&connect_timeout=30' })
await client.connect()

// Get actual column info for inventory_purchases
const cols = await client.query(`
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'inventory_purchases'
  ORDER BY ordinal_position
`)
console.log('\ninventory_purchases columns:', JSON.stringify(cols.rows, null, 2))

// Also check transactions columns
const tx = await client.query(`
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'transactions'
  ORDER BY ordinal_position
`)
console.log('\ntransactions columns:', JSON.stringify(tx.rows, null, 2))

// Also check pricing_plans
const pp = await client.query(`
  SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
  WHERE table_name = 'pricing_plans'
  ORDER BY ordinal_position
`)
console.log('\npricing_plans columns:', JSON.stringify(pp.rows, null, 2))

await client.end()
