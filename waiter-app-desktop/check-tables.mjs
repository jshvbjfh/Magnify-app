import Database from 'better-sqlite3';

async function run() {
  const dbPath = process.env.APPDATA + '/magnify-pos/magnify_waiter.db';
  const db = new Database(dbPath);

  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    console.log('Tables in database:', tables.map(t => t.name).join(', '));
  } catch (err) {
    console.error('Error listing tables:', err);
  }

  db.close();
}

run().catch(console.error);
