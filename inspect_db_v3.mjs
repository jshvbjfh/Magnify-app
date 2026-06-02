import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(process.env.APPDATA, 'magnify-pos', 'magnify_waiter.db');

try {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  
  console.log('--- Tables ---');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log(tables.map(t => t.name).join(', '));

  console.log('\n--- restaurant_config ---');
  try {
    const config = db.prepare("SELECT * FROM restaurant_config").all();
    console.log(config);
  } catch (e) {
    console.log('restaurant_config table not found or empty');
  }

  console.log('\n--- waiter_session (keys only, redacted token) ---');
  try {
    const sessions = db.prepare("SELECT * FROM waiter_session").all();
    sessions.forEach(s => {
      const entry = { ...s };
      if (entry.token) entry.token = '[REDACTED]';
      // If it's a JSON blob in one column, try to parse it
      try {
          const data = JSON.parse(entry.data || '{}');
          if (data.token) data.token = '[REDACTED]';
          console.log('Keys:', Object.keys(data), 'Redacted Data:', data);
      } catch (err) {
          console.log(entry);
      }
    });
  } catch (e) {
    console.log('waiter_session table not found or empty');
  }

  console.log('\n--- waiter_user ---');
  try {
    const users = db.prepare("SELECT * FROM waiter_user").all();
    users.forEach(u => {
        try {
            const data = JSON.parse(u.data || '{}');
            console.log('Summary:', data);
        } catch (err) {
            console.log(u);
        }
    });
  } catch (e) {
    console.log('waiter_user table not found or empty');
  }

  console.log('\n--- app_logs (latest 10) ---');
  try {
    const logs = db.prepare("SELECT * FROM app_logs ORDER BY timestamp DESC LIMIT 10").all();
    console.table(logs);
  } catch (e) {
      // Try without timestamp if column name is different
      try {
          const logs = db.prepare("SELECT * FROM app_logs ORDER BY id DESC LIMIT 10").all();
          console.table(logs);
      } catch (err2) {
          console.log('app_logs table not found or empty');
      }
  }

  db.close();
} catch (error) {
  console.error('Error:', error.message);
}
