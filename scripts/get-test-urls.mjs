const BASE = 'http://localhost:3001'
const EMAIL = 'testmanager@magnify.test'
const PASSWORD = 'Test1234!'

async function login() {
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`)
  const { csrfToken } = await csrfRes.json()
  const jar = {}
  csrfRes.headers.getSetCookie?.().forEach(c => { const [k,v] = c.split(';')[0].split('='); if(k&&v) jar[k.trim()]=v.trim() })
  const loginRes = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: Object.entries(jar).map(([k,v])=>`${k}=${v}`).join('; ') },
    body: new URLSearchParams({ csrfToken, email: EMAIL, password: PASSWORD, callbackUrl: `${BASE}/restaurant`, json: 'true' }).toString(),
    redirect: 'manual',
  })
  loginRes.headers.getSetCookie?.().forEach(c => { const [k,v] = c.split(';')[0].split('='); if(k&&v) jar[k.trim()]=v.trim() })
  return jar
}

const jar = await login()
const cookie = Object.entries(jar).map(([k,v]) => `${k}=${v}`).join('; ')

// Get branches
const brRes = await fetch(`${BASE}/api/restaurant/branches`, { headers: { Cookie: cookie } })
const { branches, activeBranchId } = await brRes.json()
const restaurant = branches[0] ? null : null

// We know restaurantId from branch data isn't returned, get it from the dish endpoint
const dishRes = await fetch(`${BASE}/api/restaurant/dishes?scope=restaurant`, { headers: { Cookie: cookie } })
const dishes = await dishRes.json()
const restaurantId = dishes[0]?.restaurantId

console.log(`Restaurant ID: ${restaurantId}`)
console.log(`Manager portal: ${BASE}/restaurant`)
console.log()
console.log('Tables per branch (for QR order URLs):')

for (const branch of branches) {
  // Switch to this branch
  const sw = await fetch(`${BASE}/api/restaurant/branches`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ branchId: branch.id }),
  })
  sw.headers.getSetCookie?.().forEach(c => { const [k,v] = c.split(';')[0].split('='); if(k&&v) jar[k.trim()]=v.trim() })
  const cookieWithBranch = Object.entries(jar).map(([k,v]) => `${k}=${v}`).join('; ')

  const tableRes = await fetch(`${BASE}/api/restaurant/tables-db`, { headers: { Cookie: cookieWithBranch } })
  const tables = await tableRes.json()
  if (Array.isArray(tables) && tables.length > 0) {
    console.log(`\n${branch.name} branch:`)
    tables.forEach(t => {
      console.log(`  ${t.name}: ${BASE}/order/${restaurantId}/${t.id}`)
    })
  }
}
