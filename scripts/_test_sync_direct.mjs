const targetUrl = 'https://magnify-app-tau.vercel.app'
const email = 'high5ive@management.com'
const password = '50000000'

const res = await fetch(`${targetUrl}/api/sync`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-sync-email': email,
    'x-sync-password': password,
  },
  body: JSON.stringify({ resolveRestaurantOnly: true }),
})

console.log('Status:', res.status)
const payload = await res.json().catch(() => null)
console.log('Body:', JSON.stringify(payload, null, 2))
