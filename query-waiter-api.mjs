import Database from 'better-sqlite3';

async function run() {
  const dbPath = process.env.APPDATA + '/magnify-pos/magnify_waiter.db';
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  const session = db.prepare('SELECT value FROM session WHERE key = ?').get('waiter_session');
  if (!session) {
    console.error('No waiter_session found in database');
    process.exit(1);
  }
  const token = session.value;

  const baseUrl = 'https://magnify-app-tau.vercel.app';
  const branchId = 'cmpeldv660004obyup3maoigb';
  const url = `${baseUrl}/api/mobile/pull?branchId=${branchId}`;

  console.log(`Requesting: ${url}`);
  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    console.log(`HTTP Status: ${response.status}`);
    if (response.ok) {
      const data = await response.json();
      console.log('Restaurant Name:', data.restaurant?.name || 'N/A');
      console.log('Branch Count:', data.branches?.length || 0);
      
      const dishes = data.dishes || [];
      console.log('Dishes Count:', dishes.length);
      console.log('Sample Dishes:', dishes.slice(0, 5).map(d => d.name).join(', '));

      const tables = data.tables || [];
      console.log('Tables Count:', tables.length);
      console.log('Sample Tables:', tables.slice(0, 5).map(t => t.name).join(', '));
    } else {
      const errorText = await response.text();
      console.error('Error Response:', errorText);
    }
  } catch (error) {
    console.error('Fetch error:', error);
  }

  db.close();
}

run().catch(console.error);
