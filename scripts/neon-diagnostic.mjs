import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { Client } = require('pg')

const NEON = 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require'
const db = new Client({ connectionString: NEON })
await db.connect()

// 1. meepmeep in Neon
const user = await db.query(`SELECT id, email, role, "restaurantId", "branchId", "isActive", "createdAt" FROM users WHERE email = 'meepmeep@gmail.com'`)
console.log('=== meepmeep in NEON ===')
console.table(user.rows)

// 2. All users for chez john2
const allUsers = await db.query(`
  SELECT u.email, u.role, u."branchId", rb.name AS branch_name, rb."isMain", u."isActive"
  FROM users u
  LEFT JOIN restaurant_branches rb ON rb.id = u."branchId"
  WHERE u."restaurantId" = 'cmoclcvse0002fqyclnwcxhmw'
  ORDER BY u.role, u."createdAt"
`)
console.log('\n=== ALL users in chez john2 (Neon) ===')
console.table(allUsers.rows)

// 3. All branches for chez john2
const branches = await db.query(`
  SELECT id, name, code, "isMain", "isActive", "sortOrder"
  FROM restaurant_branches
  WHERE "restaurantId" = 'cmoclcvse0002fqyclnwcxhmw'
  ORDER BY "isMain" DESC, "sortOrder"
`)
console.log('\n=== BRANCHES in Neon ===')
console.table(branches.rows)

// 4. Sync outbox count by branch
const outbox = await db.query(`
  SELECT "branchId", "entityType", COUNT(*) AS cnt
  FROM sync_outbox
  WHERE "restaurantId" = 'cmoclcvse0002fqyclnwcxhmw'
  AND "syncedAt" IS NULL
  GROUP BY "branchId", "entityType"
  ORDER BY "branchId", "entityType"
`)
console.log('\n=== PENDING SYNC OUTBOX (Neon, unsynced) ===')
console.table(outbox.rows)

// 5. Dish counts per branch
const dishes = await db.query(`
  SELECT "branchId", COUNT(*) AS dish_count
  FROM dishes
  WHERE "restaurantId" = 'cmoclcvse0002fqyclnwcxhmw'
  GROUP BY "branchId"
`)
console.log('\n=== DISH COUNT PER BRANCH (Neon) ===')
console.table(dishes.rows)

await db.end()
