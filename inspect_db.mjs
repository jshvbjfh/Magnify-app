import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(process.env.APPDATA, 'magnify-pos', 'magnify_waiter.db');

try {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
  console.log('Tables:', tables);

  const sessionKeys = tables.includes('sessions') ? db.prepare("SELECT key FROM sessions").all().map(s => s.key) : 'Table sessions not found';
  console.log('Session Keys:', sessionKeys);

  const config = tables.includes('restaurant_config') ? db.prepare("SELECT key, value FROM restaurant_config").all() : 'Table restaurant_config not found';
  console.log('Restaurant Config:', config);

  const counts = {
    dishes: tables.includes('dishes') ? db.prepare("SELECT count(*) as count FROM dishes").get().count : 0,
    tables: tables.includes('tables') ? db.prepare("SELECT count(*) as count FROM tables").get().count : 0,
    orders: tables.includes('orders') ? db.prepare("SELECT count(*) as count FROM orders").get().count : 0,
    unsynced_orders: tables.includes('orders') ? db.prepare("SELECT count(*) as count FROM orders WHERE synced = 0 OR synced = 'false'").get().count : 0,
  };
  console.log('Counts:', counts);

  const sampleDishes = tables.includes('dishes') ? db.prepare("SELECT name FROM dishes LIMIT 5").all().map(d => d.name) : [];
  console.log('Sample Dishes:', sampleDishes);

  const sampleTables = tables.includes('tables') ? db.prepare("SELECT name FROM tables LIMIT 5").all().map(t => t.name) : [];
  console.log('Sample Tables:', sampleTables);

  db.close();
} catch (error) {
  console.error('Error:', error.message);
}
