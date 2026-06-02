import pg from 'pg';

const client = new pg.Client({
  connectionString: 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false },
});

async function run() {
  await client.connect();
  const branchId = 'cmpeldv660004obyup3maoigb';
  
  console.log('--- Checking Branch Existing ---');
  const branchRes = await client.query('SELECT * FROM branches WHERE id = $1', [branchId]);
  console.log('Branch:', JSON.stringify(branchRes.rows, null, 2));

  if (branchRes.rows.length > 0) {
    const restaurantId = branchRes.rows[0].restaurantId;
    console.log('\n--- Checking Restaurant Existing ---');
    const restRes = await client.query('SELECT * FROM restaurants WHERE id = $1', [restaurantId]);
    console.log('Restaurant:', JSON.stringify(restRes.rows, null, 2));
  }

  await client.end();
}

run().catch(console.error);
