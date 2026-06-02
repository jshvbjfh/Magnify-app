import pg from 'pg';

const client = new pg.Client({
  connectionString: 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false },
});

async function run() {
  await client.connect();

  console.log('--- Searching Orders for Table cmpfbip1z00061379uvsskoa5 ---');
  const orderQuery = `
    SELECT id, "orderNumber", status, "tableId", "createdAt"
    FROM "Order"
    WHERE "tableId" = 'cmpfbip1z00061379uvsskoa5'
       OR "orderNumber" = 'ORD-000001'
    ORDER BY "createdAt" DESC
  `;
  
  try {
    const res = await client.query(orderQuery);
    console.log('Orders found:', JSON.stringify(res.rows, null, 2));
  } catch (err) {
    console.error('Error executing query. Trying alternative table name "orders"...');
    const altQuery = `
      SELECT id, "orderNumber", status, "tableId", "createdAt"
      FROM orders
      WHERE "tableId" = 'cmpfbip1z00061379uvsskoa5'
         OR "orderNumber" = 'ORD-000001'
      ORDER BY "createdAt" DESC
    `;
    const resAlt = await client.query(altQuery);
    console.log('Orders found (alt table):', JSON.stringify(resAlt.rows, null, 2));
  }

  await client.end();
}

run().catch(console.error);
