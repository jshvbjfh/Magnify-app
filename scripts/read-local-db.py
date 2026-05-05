import sqlite3

conn = sqlite3.connect('C:/Users/HP/AppData/Roaming/restaurant-app/data/dev.db')
conn.row_factory = sqlite3.Row
cur = conn.cursor()

print('=== RESTAURANT ===')
cur.execute("SELECT id, name, ownerId, syncRestaurantId, syncToken FROM restaurants WHERE syncRestaurantId = 'branch_b00fae69cb3529d7f390'")
for r in cur.fetchall(): print(dict(r))

print('=== BRANCHES ===')
cur.execute("""
SELECT b.id, b.restaurantId, b.name, b.code, b.isMain, b.isActive
FROM restaurant_branches b
JOIN restaurants r ON b.restaurantId = r.id
WHERE r.syncRestaurantId = 'branch_b00fae69cb3529d7f390'
""")
for r in cur.fetchall(): print(dict(r))

print('=== ALL USERS FOR THIS RESTAURANT ===')
cur.execute("""
SELECT u.id, u.email, u.role, u.restaurantId, u.branchId, u.isActive
FROM users u
JOIN restaurants r ON u.restaurantId = r.id
WHERE r.syncRestaurantId = 'branch_b00fae69cb3529d7f390'
""")
for r in cur.fetchall(): print(dict(r))


print('=== ALL BRANCHES ===')
cur.execute('SELECT id, restaurantId, name, code, isMain, isActive FROM restaurant_branches')
for r in cur.fetchall(): print(dict(r))

conn.close()
