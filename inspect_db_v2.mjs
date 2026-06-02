import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(process.env.APPDATA, 'magnify-pos', 'magnify_waiter.db');

try {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);

  // Check for session vs sessions
  const sessionData = tables.includes('session') ? db.prepare("SELECT * FROM session").all() : 'Table session not found';
  console.log('Session Table Data:', sessionData);

  // Check for restaurant_tables
  const tableCounts = tables.includes('restaurant_tables') ? db.prepare("SELECT count(*) as count FROM restaurant_tables").get().count : 0;
  const sampleRestaurantTables = tables.includes('restaurant_tables') ? db.prepare("SELECT name FROM restaurant_tables LIMIT 5").all().map(t => t.name) : [];
  
  console.log('Restaurant Tables Count:', tableCounts);
  console.log('Sample Restaurant Tables:', sampleRestaurantTables);

  db.close();
} catch (error) {
  console.error('Error:', error.message);
}
