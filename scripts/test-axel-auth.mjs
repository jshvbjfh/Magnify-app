// Test: simulate what Axel Pizzeria device sends to /api/sync
// axelpizzeria@gmail.com with password, syncRestaurantId=branch_abebdba70f480bcca3b1
import pg from 'pg'
const { Client } = pg
const client = new Client({ connectionString: 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&connect_timeout=30' })
await client.connect()

// Simulate resolveRestaurantForSyncUser logic
const userEmail = 'axelpizzeria@gmail.com'
const restaurantSyncId = 'branch_abebdba70f480bcca3b1'

const userRow = await client.query(`SELECT id, email, role, "restaurantId" FROM users WHERE email=$1`, [userEmail])
const user = userRow.rows[0]
console.log('User in Neon:', user)

const restRow = await client.query(`SELECT id, "ownerId", "syncRestaurantId" FROM restaurants WHERE "syncRestaurantId"=$1`, [restaurantSyncId])
const existingRestaurant = restRow.rows[0]
console.log('Restaurant in Neon:', existingRestaurant)

if (user && existingRestaurant) {
  const isOwner = existingRestaurant.ownerId === user.id
  const isLinkedStaff = user.restaurantId && user.restaurantId === existingRestaurant.id
  console.log('isOwner:', isOwner)
  console.log('isLinkedStaff:', isLinkedStaff)
  console.log('user.restaurantId:', user.restaurantId)
  console.log('existingRestaurant.id:', existingRestaurant.id)
  console.log('Match:', user.restaurantId === existingRestaurant.id)
  
  if (!isOwner && !isLinkedStaff) {
    console.log('WOULD GET 403: This branch is linked to a different owner account')
  } else {
    console.log('AUTH WOULD PASS')
  }
}

await client.end()
