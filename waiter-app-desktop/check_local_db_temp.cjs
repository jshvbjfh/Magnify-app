const Database = require('better-sqlite3')
const dbPath = 'C:\Users\HP\AppData\Roaming\magnify-pos\magnify_waiter.db'
const db = new Database(dbPath, { readonly: true })

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
console.log('Tables:', tables.map(t => t.name).join(', '))

const orderCount = db.prepare('SELECT COUNT(*) as c FROM orders').get()
console.log('\nTotal local orders:', orderCount.c)

const byStatus = db.prepare('SELECT status, COUNT(*) as c FROM orders GROUP BY status').all()
console.log('By status:', byStatus)

const sample = db.prepare('SELECT id, status, synced, created_at FROM orders ORDER BY created_at DESC LIMIT 5').all()
console.log('\nSample rows:', sample)

db.close()
