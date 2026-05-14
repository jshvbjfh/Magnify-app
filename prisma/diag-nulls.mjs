import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'

function getEnv(file) {
  try {
    const lines = readFileSync(file, 'utf8').split('\n')
    for (const line of lines) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq === -1) continue
      const key = t.slice(0, eq).trim()
      const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
      if (key === 'DATABASE_URL') return val
    }
  } catch {}
  return null
}

const url =
  getEnv(resolve(process.cwd(), '.env.local')) ||
  getEnv(resolve(process.cwd(), '.env'))

if (!url || !url.startsWith('postgresql')) {
  console.error('No Postgres DATABASE_URL found. Got:', url)
  process.exit(1)
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } })
await client.connect()

const { rows } = await client.query(`
  SELECT
    (SELECT COUNT(*) FROM dishes WHERE "branchId" IS NULL)                                          AS dish_nulls,
    (SELECT COUNT(*) FROM dishes WHERE "branchId" IS NULL AND "restaurantId" IS NULL)               AS dish_no_restaurant,
    (SELECT COUNT(*) FROM dishes WHERE "branchId" IS NULL AND "restaurantId" IS NOT NULL)           AS dish_has_restaurant_no_branch,
    (SELECT COUNT(*) FROM restaurant_tables WHERE "branchId" IS NULL)                               AS table_nulls,
    (SELECT COUNT(*) FROM restaurant_tables WHERE "branchId" IS NULL AND "restaurantId" IS NULL)    AS table_no_restaurant,
    (SELECT COUNT(*) FROM restaurant_tables WHERE "branchId" IS NULL AND "restaurantId" IS NOT NULL) AS table_has_restaurant_no_branch
`)
console.log('NULL branchId diagnostic:')
console.log(JSON.stringify(rows[0], null, 2))

// Also show which restaurantIds have no matching branch
const { rows: orphans } = await client.query(`
  SELECT DISTINCT d."restaurantId", COUNT(*) AS dish_count
  FROM dishes d
  WHERE d."branchId" IS NULL
    AND d."restaurantId" IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM restaurant_branches rb
      WHERE rb."restaurantId" = d."restaurantId" AND rb."isActive" = true
    )
  GROUP BY d."restaurantId"
  LIMIT 20
`)
if (orphans.length > 0) {
  console.log('\nRestaurants with NULL-branchId dishes but NO active branches:')
  console.log(JSON.stringify(orphans, null, 2))
}

await client.end()
