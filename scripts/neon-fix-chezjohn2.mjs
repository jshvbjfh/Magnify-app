import pg from 'pg'
const { Client } = pg

const client = new Client({
  connectionString: 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&connect_timeout=30'
})
await client.connect()

const NEON_RESTAURANT_ID = 'cmoclcvse0002fqyclnwcxhmw'  // chez john2 in Neon
const MAIN_BRANCH_ID = 'cmoclcy030004fqycq298t6fh'       // Main branch in Neon
const COFFEE_BRANCH_ID = 'cmocp93n702vgfqyczxqz5pr0'    // Coffee branch (owner's current, incorrect)
const OWNER_USER_ID = 'cmoco8mrx0001d1mo8dkly9yy'        // chezjohn2owner@gmail.com

// The local admin's data
const ADMIN_EMAIL = 'chezjohn2@gmail.com'
const ADMIN_NAME = 'chez john2'
const ADMIN_PASSWORD_HASH = '$2a$12$443u1f4mMrp8riv.o0941eyW7zK8UI3jIh7lHyX7ORWgwpKf4tM8u'
// New Neon-side ID for this user (local ID was cmoconif20005xxrj978ps6dl)
const NEW_USER_ID = 'cmoconif20005xxrj978ps6dl'  // reuse local id to avoid ID conflicts

// 1. Upsert chezjohn2@gmail.com into Neon users
const existing = await client.query(
  `SELECT id, email FROM users WHERE email = $1`, [ADMIN_EMAIL])

if (existing.rows.length > 0) {
  console.log('User already exists in Neon:', existing.rows[0])
  // Update restaurantId and branchId to ensure correct linking
  await client.query(
    `UPDATE users SET "restaurantId" = $1, "branchId" = $2, role = 'admin' WHERE email = $3`,
    [NEON_RESTAURANT_ID, MAIN_BRANCH_ID, ADMIN_EMAIL])
  console.log('Updated user restaurantId and branchId.')
} else {
  await client.query(
    `INSERT INTO users (id, email, name, password, role, "restaurantId", "branchId", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, 'admin', $5, $6, NOW(), NOW())`,
    [NEW_USER_ID, ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD_HASH, NEON_RESTAURANT_ID, MAIN_BRANCH_ID])
  console.log('Created chezjohn2@gmail.com in Neon with restaurantId=chez john2, branchId=Main')
}

// 2. Fix owner branchId from Coffee to Main
const ownerBefore = await client.query(
  `SELECT id, email, "branchId" FROM users WHERE id = $1`, [OWNER_USER_ID])
console.log('\nOwner branchId BEFORE:', ownerBefore.rows[0])

await client.query(
  `UPDATE users SET "branchId" = $1 WHERE id = $2`,
  [MAIN_BRANCH_ID, OWNER_USER_ID])
console.log('Updated owner branchId to Main branch')

// Verify
const verify = await client.query(
  `SELECT id, email, role, "restaurantId", "branchId" FROM users WHERE email IN ($1, $2) ORDER BY email`,
  [ADMIN_EMAIL, 'chezjohn2owner@gmail.com'])
console.log('\nVERIFICATION - Both users:', JSON.stringify(verify.rows, null, 2))

await client.end()
