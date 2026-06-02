// Rename branches to proper department names via API
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

const jar = await login()
const cookie = Object.entries(jar).map(([k,v]) => `${k}=${v}`).join('; ')

// Get current branches
const res = await fetch(`${BASE}/api/restaurant/branches`, { headers: { Cookie: cookie } })
const data = await res.json()
const branches = data.branches ?? []
console.log('Current branches:', branches.map(b => `${b.name} (${b.code}) id=${b.id}`).join(', '))

// Map old names to new names
const renames = {
  'Downtown': { name: 'Bar', code: 'BAR' },
  'Airport': { name: 'Lounge', code: 'LNG' },
  'Mall': { name: 'Bakery', code: 'BKR' },
  'Main Branch': { name: 'BBQ', code: 'BBQ' },
}

for (const branch of branches) {
  const rename = renames[branch.name]
  if (!rename) { console.log(`Skip: ${branch.name} (no rename needed)`); continue }
  const r = await fetch(`${BASE}/api/restaurant/branches/${branch.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(rename),
  })
  const result = await r.json()
  if (r.ok) console.log(`Renamed: "${branch.name}" -> "${rename.name}"`)
  else console.log(`FAILED: ${branch.name} -> ${JSON.stringify(result)}`)
}

console.log('Done.')
