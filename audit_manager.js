const Database = require('better-sqlite3');
const path = 'C:\\Users\\HP\\AppData\\Roaming\\restaurant-app\\data\\dev.db';
const db = new Database(path, { readonly: true });

function query(sql) {
    try {
        return db.prepare(sql).all();
    } catch (e) {
        return { error: e.message };
    }
}

const outboxCounts = {
    waiting: db.prepare("SELECT COUNT(*) as count FROM sync_outbox WHERE syncedAt IS NULL AND attempts = 0").get().count,
    retrying: db.prepare("SELECT COUNT(*) as count FROM sync_outbox WHERE syncedAt IS NULL AND attempts > 0 AND attempts < 8").get().count,
    exhausted: db.prepare("SELECT COUNT(*) as count FROM sync_outbox WHERE syncedAt IS NULL AND attempts >= 8").get().count,
    passed: db.prepare("SELECT COUNT(*) as count FROM sync_outbox WHERE syncedAt IS NOT NULL").get().count
};

const grouping = query("SELECT entityType, attempts, COUNT(*) as count FROM sync_outbox WHERE syncedAt IS NULL GROUP BY entityType, attempts");
const topUnsynced = query("SELECT entityType, entityId, attempts, lastError, createdAt, updatedAt FROM sync_outbox WHERE syncedAt IS NULL ORDER BY attempts DESC LIMIT 10");

const cursorSummary = {
    total: db.prepare("SELECT COUNT(*) as count FROM sync_cursors").get().count,
    distinctTargets: db.prepare("SELECT COUNT(DISTINCT target) as count FROM sync_cursors").get().count,
    recent: query("SELECT scopeId, target, lastPulledAt, lastMutationId, updatedAt FROM sync_cursors ORDER BY updatedAt DESC LIMIT 5")
};

const syncStates = query("SELECT * FROM restaurant_sync_states LIMIT 5");
const syncEvents = query("SELECT * FROM restaurant_sync_events ORDER BY id DESC LIMIT 5");
const syncBatches = query("SELECT * FROM restaurant_sync_batches ORDER BY id DESC LIMIT 5");

console.log(JSON.stringify({ outboxCounts, grouping, topUnsynced, cursorSummary, syncStates, syncEvents, syncBatches }, null, 2));
