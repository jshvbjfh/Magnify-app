import Database from 'better-sqlite3'

const DB_PATH = 'C:\\Users\\HP\\AppData\\Roaming\\restaurant-app\\data\\dev.db'
const db = new Database(DB_PATH, { readonly: true })

// What restaurant is configured locally?
const restaurant = db.prepare('SELECT id, name, syncRestaurantId FROM Restaurant LIMIT 5').all()
console.log('\nLOCAL Restaurant:', JSON.stringify(restaurant, null, 2))

// Who is the logged-in user?
const users = db.prepare('SELECT id, email, role, restaurantId, branchId FROM User LIMIT 10').all()
console.log('\nLOCAL Users:', JSON.stringify(users, null, 2))

// Dishes count
const dishCount = db.prepare('SELECT COUNT(*) as count FROM Dish').get()
console.log('\nLOCAL Dish count:', dishCount)

// Inventory count
const invCount = db.prepare('SELECT COUNT(*) as count FROM InventoryItem').get()
console.log('\nLOCAL InventoryItem count:', invCount)

// Transactions (unsynced)
const txUnsynced = db.prepare('SELECT COUNT(*) as count FROM Transaction WHERE synced = 0').get()
const txTotal = db.prepare('SELECT COUNT(*) as count FROM Transaction').get()
console.log('\nLOCAL Transactions - total:', txTotal, '| unsynced:', txUnsynced)

// SyncOutbox
const outbox = db.prepare('SELECT entityType, COUNT(*) as count FROM SyncOutbox GROUP BY entityType').all()
console.log('\nLOCAL SyncOutbox by type:', JSON.stringify(outbox, null, 2))

// Branches
const branches = db.prepare('SELECT id, name, isMain, restaurantId FROM RestaurantBranch LIMIT 10').all()
console.log('\nLOCAL Branches:', JSON.stringify(branches, null, 2))

db.close()
