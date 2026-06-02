import sqlite3

db = sqlite3.connect("C:/Users/HP/AppData/Roaming/restaurant-app/data/dev.db")

# Get restaurant names
print("=== RESTAURANTS IN DEV.DB ===")
rests = db.execute("SELECT id, name, joinCode FROM restaurants ORDER BY createdAt DESC LIMIT 15").fetchall()
for r in rests:
    print(f"  {r[0][:28]} {r[1][:30]} joinCode:{r[2]}")

# Count pending per restaurant
print("\n=== PENDING COUNTS PER RESTAURANT ===")
counts = db.execute(
    "SELECT restaurantId, COUNT(*) as cnt, MAX(attempts) as maxAtt, MIN(attempts) as minAtt "
    "FROM sync_outbox WHERE syncedAt IS NULL "
    "GROUP BY restaurantId ORDER BY cnt DESC"
).fetchall()
for r in counts:
    print(f"  {r[0][:28]} count:{r[1]} maxAtt:{r[2]} minAtt:{r[3]}")

# Duplicate entityId in outbox
print("\n=== DUPLICATE OUTBOX ENTRIES ===")
dups = db.execute(
    "SELECT entityId, COUNT(*) as cnt FROM sync_outbox WHERE syncedAt IS NULL "
    "GROUP BY entityId HAVING cnt > 1 LIMIT 10"
).fetchall()
for r in dups:
    print(f"  {r[0][:36]} count:{r[1]}")

db.close()
