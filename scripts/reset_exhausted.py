import sqlite3

db = sqlite3.connect("C:/Users/HP/AppData/Roaming/restaurant-app/data/dev.db")

# Reset Gael's pizzeria exhausted items (root causes fixed in deployed commits)
result = db.execute(
    "UPDATE sync_outbox SET attempts=0, lastError=NULL "
    "WHERE syncedAt IS NULL AND restaurantId='cmp89p55u00yn3d0hhx3fof91' AND attempts >= 8"
)
db.commit()
print(f"Reset {result.rowcount} exhausted Gael's pizzeria items")

# Remove duplicate outbox entries (keep lowest rowid per entityId+entityType)
result2 = db.execute(
    "DELETE FROM sync_outbox WHERE rowid NOT IN ("
    "  SELECT MIN(rowid) FROM sync_outbox GROUP BY entityId, entityType"
    ")"
)
db.commit()
print(f"Removed {result2.rowcount} duplicate outbox entries")

# Check final state
counts = db.execute(
    "SELECT restaurantId, COUNT(*) as cnt, MAX(attempts) as maxAtt "
    "FROM sync_outbox WHERE syncedAt IS NULL "
    "GROUP BY restaurantId ORDER BY cnt DESC"
).fetchall()
print("\nFinal pending counts:")
for r in counts:
    print(f"  {r[0][:28]} count:{r[1]} maxAtt:{r[2]}")

db.close()
