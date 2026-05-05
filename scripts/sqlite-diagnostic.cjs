/**
 * SQLite diagnostic – reads meepmeep and all waiter/branch state from the
 * Electron local database using better-sqlite3 (already installed).
 */
const Database = require('better-sqlite3')
const path = require('path')

const DB_PATH = 'C:\\Users\\HP\\AppData\\Roaming\\restaurant-app\\data\\dev.db'
const db = new Database(DB_PATH, { readonly: true })

console.log('\n=== meepmeep in SQLite ===')
const meep = db.prepare(`
  SELECT u.id, u.email, u.role, u.restaurantId, u.branchId, u.isActive, u.createdAt,
         rb.name AS branch_name
  FROM users u
  LEFT JOIN restaurant_branches rb ON rb.id = u.branchId
  WHERE u.email = 'meepmeep@gmail.com'
`).all()
console.table(meep)

console.log('\n=== ALL users for chez john2 in SQLite ===')
const allUsers = db.prepare(`
  SELECT u.email, u.role, u.branchId, rb.name AS branch_name, rb.isMain, u.isActive
  FROM users u
  LEFT JOIN restaurant_branches rb ON rb.id = u.branchId
  WHERE u.restaurantId = 'cmoclcvse0002fqyclnwcxhmw'
  ORDER BY u.role, u.createdAt
`).all()
console.table(allUsers)

console.log('\n=== BRANCHES in SQLite ===')
const branches = db.prepare(`
  SELECT id, name, code, isMain, isActive, sortOrder
  FROM restaurant_branches
  WHERE restaurantId = 'cmoclcvse0002fqyclnwcxhmw'
  ORDER BY isMain DESC, sortOrder
`).all()
console.table(branches)

console.log('\n=== PENDING SYNC OUTBOX in SQLite ===')
const outbox = db.prepare(`
  SELECT branchId, entityType, COUNT(*) AS cnt
  FROM sync_outbox
  WHERE restaurantId = 'cmoclcvse0002fqyclnwcxhmw'
  AND syncedAt IS NULL
  GROUP BY branchId, entityType
  ORDER BY branchId, entityType
`).all()
console.table(outbox.length ? outbox : [{ result: 'No pending outbox entries' }])

console.log('\n=== DISH COUNT PER BRANCH in SQLite ===')
const dishes = db.prepare(`
  SELECT branchId, COUNT(*) AS dish_count
  FROM dishes
  WHERE restaurantId = 'cmoclcvse0002fqyclnwcxhmw'
  GROUP BY branchId
`).all()
console.table(dishes)

db.close()
