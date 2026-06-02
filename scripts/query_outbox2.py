import sqlite3

db = sqlite3.connect("C:/Users/HP/AppData/Roaming/restaurant-app/data/dev.db")

# Get the FULL error for the ConnectorError items
rows = db.execute(
    "SELECT restaurantId, entityType, entityId, attempts, lastError "
    "FROM sync_outbox WHERE syncedAt IS NULL AND lastError LIKE '%ConnectorError%' LIMIT 3"
).fetchall()

print("=== FULL CONNECTOR ERRORS ===")
for r in rows:
    print(f"\nRestaurant: {r[0]}")
    print(f"Entity: {r[1]} {r[2]}")
    print(f"Attempts: {r[3]}")
    print(f"FULL ERROR:\n{r[4]}")
    print("---")

# Jesse Pizzera items (local restaurant)
jesse_local = db.execute(
    "SELECT entityType, entityId, attempts, lastError "
    "FROM sync_outbox WHERE restaurantId='cmoshmlhi001hgg0ofota9q3q' ORDER BY attempts DESC LIMIT 20"
).fetchall()
print("\n=== JESSE PIZZERA LOCAL ITEMS (cmoshmlhi...) ===")
print("Count:", len(jesse_local))
for r in jesse_local:
    print(f"  {r[0]} {r[1][:28]} att:{r[2]} err:{(r[3] or '')[:60]}")

db.close()
