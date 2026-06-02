const { Client } = require('pg');
const dotenv = require('dotenv');

// Load env vars
dotenv.config({ path: '.env.local' });
dotenv.config();

async function runAudit() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    try {
        await client.connect();

        const batchCounts = await client.query(`
            SELECT status, COUNT(*) as count 
            FROM restaurant_sync_batches 
            GROUP BY status
        `);

        const failedBatches = await client.query(`
            SELECT "batchId", status, "errorMessage", "receivedAt", "appliedAt", "restaurantId"
            FROM restaurant_sync_batches
            WHERE status IN ('FAILED', 'partially_applied', 'error')
            ORDER BY "receivedAt" DESC
            LIMIT 10
        `);

        const syncStates = await client.query(`
            SELECT "restaurantId", "lastSuccessAt", "lastFailureAt", "consecutiveFailures", "lastErrorMessage", 
                   "lastSyncedTransactions", "lastSyncedSummaries"
            FROM restaurant_sync_states
            ORDER BY "lastFailureAt" DESC NULLS LAST
            LIMIT 10
        `);

        // Check for sync_outbox in cloud (if it exists)
        let outboxSummary = 'Table sync_outbox not found';
        try {
            const outboxCheck = await client.query(`
                SELECT 
                    COUNT(*) FILTER (WHERE "syncedAt" IS NULL AND attempts = 0) as waiting,
                    COUNT(*) FILTER (WHERE "syncedAt" IS NULL AND attempts > 0 AND attempts < 8) as retrying,
                    COUNT(*) FILTER (WHERE "syncedAt" IS NULL AND attempts >= 8) as exhausted,
                    COUNT(*) FILTER (WHERE "syncedAt" IS NOT NULL) as passed
                FROM sync_outbox
            `);
            outboxSummary = outboxCheck.rows[0];
        } catch (e) {}

        const cursors = await client.query(`
            SELECT "scopeId", target, "lastPulledAt", "branchId", "updatedAt"
            FROM sync_cursors
            ORDER BY "lastPulledAt" ASC NULLS FIRST
            LIMIT 10
        `);

        console.log(JSON.stringify({ 
            batchCounts: batchCounts.rows, 
            failedBatches: failedBatches.rows, 
            syncStates: syncStates.rows, 
            outboxSummary,
            anomalousCursors: cursors.rows
        }, null, 2));

    } catch (err) {
        console.error('Error connecting to DB:', err.message);
    } finally {
        await client.end();
    }
}

runAudit();
