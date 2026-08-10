const base = 'http://localhost:3001'
const email = 'high5ive@management.com'
const password = '50000000'

function extractCookies(res, jar) {
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : (res.headers.raw?.()['set-cookie'] ?? [])
  for (const c of setCookie) {
    const [pair] = c.split(';')
    const [k, v] = pair.split('=')
    jar[k] = v
  }
}

function cookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ')
}

const jar = {}

// 1. Get CSRF token
const csrfRes = await fetch(`${base}/api/auth/csrf`)
extractCookies(csrfRes, jar)
const { csrfToken } = await csrfRes.json()
console.log('CSRF token obtained:', !!csrfToken)

// 2. Sign in via credentials callback
const signinRes = await fetch(`${base}/api/auth/callback/credentials`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    Cookie: cookieHeader(jar),
  },
  body: new URLSearchParams({ email, password, csrfToken, json: 'true' }),
  redirect: 'manual',
})
extractCookies(signinRes, jar)
console.log('Sign-in status:', signinRes.status)

// 3. Confirm session
const sessionRes = await fetch(`${base}/api/auth/session`, { headers: { Cookie: cookieHeader(jar) } })
const session = await sessionRes.json()
console.log('Session user:', session?.user)

if (!session?.user) {
  console.log('LOGIN FAILED - cannot proceed to sync test')
  process.exit(1)
}

// 4. Call /api/sync/local exactly as the client would
const syncRes = await fetch(`${base}/api/sync/local`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Cookie: cookieHeader(jar),
  },
  body: JSON.stringify({ targetUrl: 'https://magnify-app-tau.vercel.app', email, password }),
})
console.log('Sync status:', syncRes.status)
const syncPayload = await syncRes.json().catch(() => null)
console.log('Sync body:', JSON.stringify(syncPayload, null, 2))
