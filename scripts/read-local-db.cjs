const Database = require('better-sqlite3')
const db = new Database('C:/Users/HP/AppData/Roaming/restaurant-app/data/dev.db', { readonly: true })

const restaurants = db.prepare('SELECT id, name, ownerId, syncRestaurantId, syncToken FROM restaurants').all()
console.log('RESTAURANTS:')
console.table(restaurants)

const users = db.prepare("SELECT id, email, role, restaurantId, branchId FROM users WHERE role IN ('admin','owner')").all()
console.log('ADMIN/OWNER USERS:')
console.table(users)

const branches = db.prepare('SELECT id, restaurantId, name, code, isMain, isActive FROM restaurant_branches').all()
console.log('BRANCHES:')
console.table(branches)

const waiters = db.prepare("SELECT id, email, role, restaurantId, branchId FROM users WHERE role = 'waiter'").all()
console.log('WAITERS:')
console.table(waiters)

db.close()
