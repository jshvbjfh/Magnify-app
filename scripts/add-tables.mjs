/**
 * Adds tables to each department branch via the REST API.
 */
const BASE = 'http://localhost:3001'
const EMAIL = 'testmanager@magnify.test'
const PASSWORD = 'Test1234!'

async function login() {
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`)
  const csrfCookies = csrfRes.headers.getSetCookie?.() ?? []
  const { csrfToken } = await csrfRes.json()
  const jar = {}
  csrfCookies.forEach(c => { const [k,v] = c.split(';')[0].split('='); if(k&&v) jar[k.trim()]=v.trim() })
  const loginRes = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: Object.entries(jar).map(([k,v])=>`${k}=${v}`).join('; ') },
    body: new URLSearchParams({ csrfToken, email: EMAIL, password: PASSWORD, callbackUrl: `${BASE}/restaurant`, json: 'true' }).toString(),
    redirect: 'manual',
  })
  loginRes.headers.getSetCookie?.().forEach(c => { const [k,v] = c.split(';')[0].split('='); if(k&&v) jar[k.trim()]=v.trim() })
  return jar
}

const BRANCH_TABLES = {
  'BBQ':     [{ name: 'Table 1', seats: 4 }, { name: 'Table 2', seats: 4 }, { name: 'Table 3', seats: 6 }, { name: 'Table 4', seats: 2 }],
  'Bar':     [{ name: 'Bar Seat 1', seats: 2 }, { name: 'Bar Seat 2', seats: 2 }, { name: 'Bar Seat 3', seats: 2 }],
  'Lounge':  [{ name: 'Lounge 1', seats: 4 }, { name: 'Lounge 2', seats: 6 }, { name: 'Lounge 3', seats: 4 }],
  'Bakery':  [{ name: 'Cafe 1', seats: 2 }, { name: 'Cafe 2', seats: 4 }],
}

async function run() {
  const jar = await login()
  if (!jar['next-auth.session-token']) { console.error('Login failed'); process.exit(1) }
  console.log('Logged in.')

  // Get branches
  const brRes = await fetch(`${BASE}/api/restaurant/branches`, {
    headers: { Cookie: Object.entries(jar).map(([k,v]) => `${k}=${v}`).join('; ') }
  })
  const brData = await brRes.json()
  const branches = brData.branches ?? []
  console.log('Branches:', branches.map(b => b.name).join(', '))

  for (const [branchName, tables] of Object.entries(BRANCH_TABLES)) {
    const branch = branches.find(b => b.name === branchName)
    if (!branch) { console.log(`Branch not found: ${branchName}`); continue }

    // Switch to this branch
    const switchRes = await fetch(`${BASE}/api/restaurant/branches`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: Object.entries(jar).map(([k,v]) => `${k}=${v}`).join('; ') },
      body: JSON.stringify({ branchId: branch.id }),
    })
    const switchData = await switchRes.json()
    // Capture updated cookies (active branch cookie)
    switchRes.headers.getSetCookie?.().forEach(c => { const [k,v] = c.split(';')[0].split('='); if(k&&v) jar[k.trim()]=v.trim() })
    if (!switchRes.ok) { console.log(`  FAIL switching to ${branchName}: ${JSON.stringify(switchData)}`); continue }
    console.log(`\nSwitched to ${branchName} (${switchData.activeBranchId?.slice(-6)})`)

    // Check existing tables
    const existRes = await fetch(`${BASE}/api/restaurant/tables-db`, {
      headers: { Cookie: Object.entries(jar).map(([k,v]) => `${k}=${v}`).join('; ') }
    })
    const existing = await existRes.json().catch(() => [])
    const existingNames = new Set((Array.isArray(existing) ? existing : []).map(t => t.name))
    console.log(`  Existing tables: ${existingNames.size > 0 ? [...existingNames].join(', ') : 'none'}`)

    for (const table of tables) {
      if (existingNames.has(table.name)) { console.log(`  SKIP (exists): ${table.name}`); continue }
      const r = await fetch(`${BASE}/api/restaurant/tables-db`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: Object.entries(jar).map(([k,v]) => `${k}=${v}`).join('; ') },
        body: JSON.stringify(table),
      })
      const result = await r.json()
      if (r.ok) console.log(`  Added: ${table.name} (${table.seats} seats)`)
      else console.log(`  FAIL: ${table.name} -> ${JSON.stringify(result)}`)
    }
  }

  console.log('\nDone.')
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
