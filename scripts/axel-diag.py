import sqlite3

db = sqlite3.connect(r'C:\Users\HP\AppData\Roaming\restaurant-app\data\dev.db')
c = db.cursor()

# Get Axel Pizzeria local info
c.execute("SELECT id, ownerId, syncRestaurantId, syncToken FROM restaurants WHERE syncRestaurantId='branch_abebdba70f480bcca3b1'")
row = c.fetchone()
print('Axel Pizzeria local restaurant:', row)
restId = row[0] if row else None

if restId:
    c.execute("SELECT email, role, id FROM users WHERE restaurantId=?", (restId,))
    print('Local users for Axel Pizzeria:', c.fetchall())

    # Who is logged in / admin
    c.execute("SELECT ownerId FROM restaurants WHERE id=?", (restId,))
    owner = c.fetchone()
    print('ownerId:', owner)
    c.execute("SELECT id, email, role FROM users WHERE id=?", (owner[0],))
    print('Owner user:', c.fetchone())

db.close()
