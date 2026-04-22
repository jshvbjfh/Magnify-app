import Database from 'better-sqlite3';

const dbPath = 'C:/Users/HP/AppData/Roaming/restaurant-app/data/dev.db';
const db = new Database(dbPath, { readonly: true });

console.log('=== Sync Outbox (first 10) ===');
try {
  const outbox = db.prepare(`SELECT * FROM sync_outbox ORDER BY rowid LIMIT 10`).all();
  for (const o of outbox) console.log(JSON.stringify(o));
  console.log(`Total outbox: ${db.prepare('SELECT COUNT(*) as c FROM sync_outbox').get().c}`);
} catch(e) { console.log('Error:', e.message); }

console.log('\n=== app_schema_state ===');
try {
  const state = db.prepare(`SELECT * FROM app_schema_state`).all();
  for (const s of state) console.log(JSON.stringify(s, null, 2));
} catch(e) { console.log('Error:', e.message); }

console.log('\n=== branch_devices ===');
try {
  const devices = db.prepare(`SELECT * FROM branch_devices`).all();
  for (const d of devices) console.log(JSON.stringify(d, null, 2));
} catch(e) { console.log('Error:', e.message); }

console.log('\n=== Restaurant sync tokens ===');
try {
  const rests = db.prepare(`SELECT id, name, syncRestaurantId, syncToken FROM restaurants`).all();
  for (const r of rests) {
    console.log(`  ${r.name}: syncId=${r.syncRestaurantId || 'NULL'}, token=${r.syncToken ? r.syncToken.substring(0,12)+'...' : 'NULL'}`);
  }
} catch(e) { console.log('Error:', e.message); }

db.close();
