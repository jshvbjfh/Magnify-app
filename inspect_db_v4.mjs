import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.join(process.env.APPDATA, 'magnify-pos', 'magnify_waiter.db');

try {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  
  console.log('\n--- session (redacted token) ---');
  try {
    const sessions = db.prepare("SELECT * FROM session").all();
    console.log('Session row count:', sessions.length);
    sessions.forEach(s => {
      const entry = { ...s };
      if (entry.token) entry.token = '[REDACTED]';
      if (entry.user && typeof entry.user === 'string') {
          try {
              const userData = JSON.parse(entry.user);
              if (userData.token) userData.token = '[REDACTED]';
              console.log('Session Keys:', Object.keys(entry), 'User summary:', userData);
          } catch (e) {
              console.log('Session entry (user not JSON):', entry);
          }
      } else {
          console.log('Session entry:', entry);
      }
    });
  } catch (e) {
    console.log('Table session failed:', e.message);
  }

  db.close();
} catch (error) {
  console.error('Error:', error.message);
}
