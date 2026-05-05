import sqlite3, json

db = sqlite3.connect(r'C:\Users\HP\AppData\Roaming\restaurant-app\data\dev.db')
c = db.cursor()

# Get restaurant sync info
c.execute("SELECT syncRestaurantId, syncToken, name FROM restaurants LIMIT 3")
rows = c.fetchall()
print("Restaurant sync info:", rows)

# Get tables in the DB
c.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
tables = [r[0] for r in c.fetchall()]
print("Tables:", tables)

# Count recent transactions
if 'transactions' in tables:
    c.execute("SELECT COUNT(*) FROM transactions")
    print("Transaction count:", c.fetchone()[0])
    c.execute("SELECT id, amount, type, description, createdAt, synced FROM transactions ORDER BY createdAt DESC LIMIT 5")
    txs = c.fetchall()
    print("Recent transactions:", txs)

# Check sync outbox
if 'sync_outbox' in tables:
    c.execute("SELECT COUNT(*) FROM sync_outbox WHERE syncedAt IS NULL")
    print("Pending outbox items:", c.fetchone()[0])
    c.execute("SELECT entityType, operation, attempts, lastError FROM sync_outbox WHERE syncedAt IS NULL LIMIT 10")
    print("Pending outbox sample:", c.fetchall())

db.close()
