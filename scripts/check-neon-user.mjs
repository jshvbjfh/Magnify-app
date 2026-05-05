import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { Client } = require('pg')

const NEON = 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require'

const neon = new Client({ connectionString: NEON })
await neon.connect()

// chez john2 branches:
//   Main:         cmoclcy030004fqycq298t6fh
//   Coffee:       cmocp93n702vgfqyczxqz5pr0
//   chez john BBQ: cmocpbfgm02zofqycq94wqgub

// Fix: assign waiters to their correct branch.
// Edit the rows below to match which waiter belongs to which branch.
const UPDATES = [
  { email: 'bobolo@gmail.com', branchId: 'cmocp93n702vgfqyczxqz5pr0' },  // Coffee
  { email: 'popolo@gmail.com', branchId: 'cmocp93n702vgfqyczxqz5pr0' },  // Coffee
  { email: 'dodolo@gmail.com', branchId: 'cmocp93n702vgfqyczxqz5pr0' },  // Coffee
  // kokolo stays on Main — no change needed
]

if (UPDATES.length === 0) {
  console.log('No updates configured. Uncomment the rows in UPDATES to apply fixes.')
} else {
  for (const u of UPDATES) {
    const r = await neon.query(
      `UPDATE users SET "branchId" = $1 WHERE email = $2 RETURNING id, email, "branchId"`,
      [u.branchId, u.email]
    )
    console.log('Updated:', r.rows[0])
  }
  console.log('Done.')
}

// Show current state
const waiters = await neon.query(`
  SELECT u.email, u.role, u."branchId", rb.name AS branch_name, rb."isMain"
  FROM users u
  LEFT JOIN restaurant_branches rb ON rb.id = u."branchId"
  WHERE u."restaurantId" = 'cmoclcvse0002fqyclnwcxhmw'
  AND u.role IN ('waiter', 'kitchen')
  ORDER BY u."createdAt"
`)
console.log('\nCurrent waiter branches for chez john2:')
console.table(waiters.rows)

await neon.end()



await neon.end()
