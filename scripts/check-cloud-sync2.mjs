import pg from 'pg';

const client = new pg.Client({
  connectionString: 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false },
});

await client.connect();

const summaries = await client.query('SELECT date, "totalRevenue", "totalExpenses", "profitLoss", synced, "restaurantId" FROM daily_summaries ORDER BY date DESC LIMIT 10');
console.log('=== Daily summaries:', summaries.rows.length, '===');
for (const s of summaries.rows) console.log(JSON.stringify(s));

const syncedTxns = await client.query(`
  SELECT t.description, t.amount, t.type, t.synced, c.type as "catType", t."sourceKind", t."restaurantId"
  FROM transactions t
  LEFT JOIN categories c ON t."categoryId" = c.id
  WHERE t.synced = true
  ORDER BY t.date DESC
  LIMIT 20
`);
console.log('\n=== Synced transactions:', syncedTxns.rows.length, '===');
for (const t of syncedTxns.rows) console.log(JSON.stringify(t));

const counts = await client.query(`
  SELECT
    COUNT(*) as total,
    SUM(CASE WHEN synced = true THEN 1 ELSE 0 END) as synced,
    SUM(CASE WHEN synced = false THEN 1 ELSE 0 END) as unsynced
  FROM transactions
`);
console.log('\n=== Transaction counts ===');
console.log(JSON.stringify(counts.rows[0]));

const batches = await client.query('SELECT "batchId", status, "syncedTransactions", "syncedSummaries", "appliedAt" FROM restaurant_sync_batches ORDER BY "appliedAt" DESC NULLS LAST LIMIT 5');
console.log('\n=== Sync batches:', batches.rows.length, '===');
for (const b of batches.rows) console.log(JSON.stringify(b));

const states = await client.query('SELECT "restaurantId", "lastSuccessAt", "lastErrorMessage", "consecutiveFailures", "lastSyncedTransactions", "lastSyncedSummaries" FROM restaurant_sync_states');
console.log('\n=== Sync states:', states.rows.length, '===');
for (const s of states.rows) console.log(JSON.stringify(s));

// Revenue breakdown by restaurant for Acme2
const acme2Rev = await client.query(`
  SELECT t.type, c.type as "catType", t."sourceKind", SUM(t.amount) as total, COUNT(*) as cnt
  FROM transactions t
  LEFT JOIN categories c ON t."categoryId" = c.id
  WHERE t.synced = true
  GROUP BY t.type, c.type, t."sourceKind"
  ORDER BY total DESC
`);
console.log('\n=== Synced revenue breakdown ===');
for (const r of acme2Rev.rows) console.log(JSON.stringify(r));

await client.end();
