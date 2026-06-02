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

const brRes = await fetch(`${BASE}/api/restaurant/branches`, { headers: { Cookie: cookie } })
const brData = await brRes.json()
const branches = brData.branches ?? []
console.log('Branches:', branches.map(b => `${b.name} (${b.id.slice(-6)})`).join(', '))
console.log('Active branch:', brData.activeBranchId)

const dishRes = await fetch(`${BASE}/api/restaurant/dishes?scope=restaurant`, { headers: { Cookie: cookie } })
const dishes = await dishRes.json()
const byBranch = {}
dishes.forEach(d => {
  byBranch[d.branchId] = byBranch[d.branchId] || []
  byBranch[d.branchId].push(d.name)
})
console.log('\nDishes per branch:')
for (const [bid, names] of Object.entries(byBranch)) {
  const branch = branches.find(b => b.id === bid)
  console.log(`  ${branch?.name ?? bid}: ${names.join(', ')}`)
}
console.log(`\nTotal: ${dishes.length} dishes`)
