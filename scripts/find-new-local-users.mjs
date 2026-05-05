import Database from '../node_modules/better-sqlite3/lib/index.js'
import pg from 'pg'
import path from 'path'
import os from 'os'

const dbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'restaurant-app', 'data', 'dev.db')
const db = new Database(dbPath, { readonly: true })

const localUsers = db.prepare(`SELECT id, email, name, role, restaurantId, branchId, createdAt FROM users ORDER BY createdAt DESC LIMIT 20`).all()
console.log('Local users (newest first):')
for (const u of localUsers) {
  console.log(`  ${u.email} | role=${u.role} | restaurantId=${u.restaurantId} | createdAt=${u.createdAt}`)
}

const { Client } = pg
const client = new Client({ connectionString: 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&connect_timeout=30' })
await client.connect()

console.log('\nChecking which are missing from Neon:')
for (const u of localUsers) {
  const res = await client.query('SELECT id FROM users WHERE email = $1', [u.email])
  if (res.rows.length === 0) {
    console.log(`  MISSING in Neon: ${u.email} (role=${u.role})`)
  } else {
    console.log(`  OK in Neon:      ${u.email}`)
  }
}

await client.end()
db.close()
