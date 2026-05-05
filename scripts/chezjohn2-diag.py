import sqlite3

db = sqlite3.connect(r'C:\Users\HP\AppData\Roaming\restaurant-app\data\dev.db')
c = db.cursor()

c.execute("SELECT id FROM restaurants WHERE syncRestaurantId='branch_b00fae69cb3529d7f390'")
row = c.fetchone()
restId = row[0] if row else None
print('Local restaurant id:', restId)

if restId:
    c.execute('SELECT entityType, operation, attempts, lastError, syncedAt FROM sync_outbox WHERE restaurantId=? ORDER BY createdAt DESC LIMIT 20', (restId,))
    print('Outbox for chezjohn2 (last 20):', c.fetchall())

    c.execute('SELECT COUNT(*) FROM transactions WHERE restaurantId=?', (restId,))
    print('Local transactions for chezjohn2:', c.fetchone()[0])

    c.execute('SELECT * FROM restaurant_sync_states WHERE restaurantId=?', (restId,))
    print('Sync states:', c.fetchall())

    c.execute('SELECT status, message, consecutiveFailures, createdAt FROM restaurant_sync_events WHERE restaurantId=? ORDER BY createdAt DESC LIMIT 5', (restId,))
    print('Recent sync events:', c.fetchall())

    c.execute('SELECT email, role FROM users WHERE restaurantId=?', (restId,))
    print('Local users for chezjohn2:', c.fetchall())

db.close()
