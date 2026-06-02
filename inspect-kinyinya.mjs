import pg from 'pg';

const client = new pg.Client({
  connectionString: 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false },
});

async function run() {
  await client.connect();

  console.log('--- Searching Staff/Users ---');
  const staffQuery = `
    SELECT s.id, s.username, s."restaurantId", s."branchId", s."branchIds", s."createdAt", s.role
    FROM staff s
    WHERE s.username LIKE 'kinyinya%' 
       OR s.username = 'kinyinyawaiterep@gmail.com' 
       OR s.username = 'kinyinyawaiterjp@gmail.com'
  `;
  const staffRes = await client.query(staffQuery);
  console.log('Staff result:', JSON.stringify(staffRes.rows, null, 2));

  if (staffRes.rows.length > 0) {
    const restaurantIds = [...new Set(staffRes.rows.map(s => s.restaurantId))];
    console.log('\n--- Searching Restaurants ---');
    const restQuery = `
      SELECT id, name, "joinCode", "ownerEmail"
      FROM restaurants
      WHERE id = ANY($1)
    `;
    const restRes = await client.query(restQuery, [restaurantIds]);
    console.log('Restaurants result:', JSON.stringify(restRes.rows, null, 2));
    
    console.log('\n--- Searching Branches ---');
    const branchIds = [...new Set(staffRes.rows.flatMap(s => {
      const ids = [];
      if (s.branchId) ids.push(s.branchId);
      if (Array.isArray(s.branchIds)) ids.push(...s.branchIds);
      return ids;
    }))];
    
    if (branchIds.length > 0) {
        const branchQuery = `
          SELECT id, name, "restaurantId"
          FROM branches
          WHERE id = ANY($1)
        `;
        const branchRes = await client.query(branchQuery, [branchIds]);
        console.log('Branches result:', JSON.stringify(branchRes.rows, null, 2));
    }
  }

  await client.end();
}

run().catch(console.error);
