import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(process.env.APPDATA, 'magnify-pos', 'magnify_waiter.db');

try {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  
  console.log('--- restaurant_config ---');
  const config = db.prepare("SELECT * FROM restaurant_config").all();
  config.forEach(row => console.log(`${row.key}: ${row.value}`));

  console.log('\n--- session (redacted) ---');
  const sessionRows = db.prepare("SELECT * FROM session").all();
  sessionRows.forEach(row => {
    if (row.key === 'waiter_session') {
      console.log('waiter_session: [REDACTED]');
    } else if (row.key === 'waiter_user') {
      try {
        const user = JSON.parse(row.value);
        console.log('waiter_user:', user);
      } catch (e) {
        console.log('waiter_user (raw):', row.value);
      }
    } else {
      console.log(`${row.key}: ${row.value}`);
    }
  });

  console.log('\n--- app_logs (latest 10) ---');
  const logs = db.prepare("SELECT * FROM app_logs ORDER BY created_at DESC LIMIT 10").all();
  console.table(logs.map(l => ({
    id: l.id,
    level: l.level,
    scope: l.scope,
    message: l.message,
    timestamp: l.created_at
  })));

  db.close();
} catch (error) {
  console.error('Error:', error.message);
}
