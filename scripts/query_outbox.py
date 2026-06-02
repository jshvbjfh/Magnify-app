import sqlite3

db = sqlite3.connect("C:/Users/HP/AppData/Roaming/restaurant-app/data/dev.db")

# All pending with full errors
rows = db.execute(
    "SELECT restaurantId, entityType, entityId, attempts, lastError "
    "FROM sync_outbox WHERE syncedAt IS NULL ORDER BY attempts DESC LIMIT 30"
).fetchall()

print("=== PENDING ITEMS ===")
print("Count:", len(rows))

seen_errors = set()
for r in rows:
    err = (r[4] or "")
    key = err[:60]
    short_err = err[:120]
    print(f"\n  {r[1]} {r[2][:28]} att:{r[3]}")
    if key not in seen_errors:
        seen_errors.add(key)
        print(f"  ERROR: {short_err}")
    else:
        print(f"  ERROR: (same as above)")

# Items with attempts=0
zero = db.execute(
    "SELECT restaurantId, entityType, entityId, attempts FROM sync_outbox WHERE syncedAt IS NULL AND attempts = 0"
).fetchall()
print("\n=== ATTEMPTS=0 (not yet tried) ===")
for r in zero:
    print(f"  {r[0][:24]} {r[1]} {r[2][:28]}")

db.close()
