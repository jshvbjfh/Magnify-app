import Database from 'better-sqlite3';

const dbPath = 'C:/Users/HP/AppData/Roaming/restaurant-app/data/dev.db';
const db = new Database(dbPath, { readonly: true });

const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'`).all().map(r => r.name);

console.log(`Production DB: ${dbPath}`);
console.log(`Tables: ${tables.length}\n`);

console.log('=== Tables with data ===');
for (const t of tables) {
  const count = db.prepare(`SELECT COUNT(*) as c FROM "${t}"`).get().c;
  if (count > 0) console.log(`  ${t}: ${count} rows`);
}

// Check key tables in detail
console.log('\n=== Restaurants ===');
try {
  const restaurants = db.prepare(`SELECT * FROM restaurants`).all();
  for (const r of restaurants) {
    console.log(JSON.stringify(r, null, 2));
  }
} catch(e) { console.log('Error:', e.message); }

console.log('\n=== Users (admin/owners) ===');
try {
  const users = db.prepare(`SELECT id, email, role, name FROM users LIMIT 10`).all();
  for (const u of users) console.log(JSON.stringify(u));
} catch(e) { console.log('Error:', e.message); }

console.log('\n=== Transactions (sample 5) ===');
try {
  const txns = db.prepare(`SELECT id, type, amount, createdAt, synced FROM transactions ORDER BY createdAt DESC LIMIT 5`).all();
  for (const t of txns) console.log(JSON.stringify(t));
} catch(e) { console.log('Error:', e.message); }

console.log('\n=== Daily Summaries ===');
try {
  const summaries = db.prepare(`SELECT * FROM daily_summaries ORDER BY date DESC LIMIT 5`).all();
  console.log(`Count: ${summaries.length}`);
  for (const s of summaries) console.log(JSON.stringify(s));
} catch(e) { console.log('Error:', e.message); }

console.log('\n=== Sync-related tables ===');
const syncTables = ['sync_outbox', 'sync_cursors', 'restaurant_sync_batches', 'restaurant_sync_events', 'restaurant_sync_states'];
for (const st of syncTables) {
  try {
    const count = db.prepare(`SELECT COUNT(*) as c FROM "${st}"`).get().c;
    console.log(`  ${st}: ${count} rows`);
    if (count > 0 && count < 10) {
      const rows = db.prepare(`SELECT * FROM "${st}"`).all();
      for (const r of rows) console.log('    ' + JSON.stringify(r));
    }
  } catch(e) { console.log(`  ${st}: ${e.message}`); }
}

console.log('\n=== Dish Sales (count + sample) ===');
try {
  const count = db.prepare(`SELECT COUNT(*) as c FROM dish_sales`).get().c;
  console.log(`Count: ${count}`);
  const sample = db.prepare(`SELECT * FROM dish_sales ORDER BY createdAt DESC LIMIT 3`).all();
  for (const s of sample) console.log(JSON.stringify(s));
} catch(e) { console.log('Error:', e.message); }

db.close();
