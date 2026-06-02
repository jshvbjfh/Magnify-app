/**
 * Seed script: authenticates via NextAuth credentials, then calls REST APIs
 * to create 4 branches and 25 menu items for the test restaurant.
 *
 * Run: node scripts/seed-restaurant-data.mjs
 */

const BASE = 'http://localhost:3001'
const EMAIL = 'testmanager@magnify.test'
const PASSWORD = 'Test1234!'

const log = msg => console.log(`[${new Date().toISOString()}] ${msg}`)
const errors = []
const err = msg => { errors.push(msg); log(`ERROR: ${msg}`) }

// ── Helpers ──────────────────────────────────────────────────────────────────

let sessionCookie = ''

async function apiGet(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Cookie: sessionCookie },
    credentials: 'include',
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    err(`GET ${path} → ${res.status}: ${body.slice(0, 200)}`)
    return null
  }
  return res.json()
}

async function apiPost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie,
    },
    body: JSON.stringify(body),
  })
  const raw = await res.text()
  let data
  try { data = JSON.parse(raw) } catch { data = raw }
  if (!res.ok) {
    err(`POST ${path} → ${res.status}: ${raw.slice(0, 300)}`)
    return null
  }
  return data
}

async function apiPatch(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie,
    },
    body: JSON.stringify(body),
  })
  const raw = await res.text()
  let data
  try { data = JSON.parse(raw) } catch { data = raw }
  if (!res.ok) {
    err(`PATCH ${path} → ${res.status}: ${raw.slice(0, 300)}`)
    return null
  }
  return data
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function parseCookieHeader(headerValue) {
  // Each cookie header is "name=value; Path=/; HttpOnly; ..."
  const firstPart = headerValue.split(';')[0].trim()
  const eq = firstPart.indexOf('=')
  if (eq < 0) return null
  return { name: firstPart.slice(0, eq).trim(), value: firstPart.slice(eq + 1).trim() }
}

async function login() {
  // Step 1: Get CSRF token — collect all set-cookie headers
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`)
  const csrfSetCookies = csrfRes.headers.getSetCookie?.() ?? [csrfRes.headers.get('set-cookie') ?? '']
  const csrfBody = await csrfRes.json()
  const csrfToken = csrfBody.csrfToken
  log(`CSRF token: ${csrfToken?.slice(0, 12)}...`)
  log(`CSRF set-cookies: ${csrfSetCookies.length} — ${csrfSetCookies.map(c => c.split(';')[0]).join(' | ')}`)

  // Build cookie jar from CSRF response
  const cookieJar = {}
  csrfSetCookies.filter(Boolean).forEach(c => {
    const parsed = parseCookieHeader(c)
    if (parsed) cookieJar[parsed.name] = parsed.value
  })

  const csrfCookieString = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ')

  // Step 2: Sign in with credentials
  const formData = new URLSearchParams({
    csrfToken,
    email: EMAIL,
    password: PASSWORD,
    callbackUrl: `${BASE}/restaurant`,
    json: 'true',
  })

  const loginRes = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: csrfCookieString,
    },
    body: formData.toString(),
    redirect: 'manual',
  })

  log(`Login response: ${loginRes.status} ${loginRes.statusText}`)
  const loginBody = await loginRes.text().catch(() => '')
  log(`Login body: ${loginBody.slice(0, 200)}`)

  // Collect all set-cookie headers from login response
  const loginSetCookies = loginRes.headers.getSetCookie?.() ?? [loginRes.headers.get('set-cookie') ?? '']
  log(`Login set-cookies (${loginSetCookies.length}): ${loginSetCookies.map(c => c.split(';')[0]).join(' | ')}`)

  loginSetCookies.filter(Boolean).forEach(c => {
    const parsed = parseCookieHeader(c)
    if (parsed) cookieJar[parsed.name] = parsed.value
  })

  sessionCookie = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ')
  log(`Cookie jar (${Object.keys(cookieJar).length} cookies): ${Object.keys(cookieJar).join(', ')}`)

  // If still no session token, try following the redirect
  if (!cookieJar['next-auth.session-token'] && (loginRes.status === 302 || loginRes.status === 301)) {
    const redirectUrl = loginRes.headers.get('location')
    log(`Following redirect to: ${redirectUrl}`)
    if (redirectUrl) {
      const redirectRes = await fetch(redirectUrl, {
        headers: { Cookie: sessionCookie },
        redirect: 'manual',
      })
      const redirectCookies = redirectRes.headers.getSetCookie?.() ?? [redirectRes.headers.get('set-cookie') ?? '']
      redirectCookies.filter(Boolean).forEach(c => {
        const parsed = parseCookieHeader(c)
        if (parsed) cookieJar[parsed.name] = parsed.value
      })
      sessionCookie = Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ')
      log(`After redirect cookie jar: ${Object.keys(cookieJar).join(', ')}`)
    }
  }

  // Verify session
  const sessRes = await fetch(`${BASE}/api/auth/session`, {
    headers: { Cookie: sessionCookie },
  })
  const sess = await sessRes.json()
  if (!sess?.user?.id) {
    err(`Session not established — login may have failed. Session response: ${JSON.stringify(sess).slice(0, 200)}`)
    return false
  }
  log(`Logged in as: ${sess.user.email} (role: ${sess.user.role}, restaurantId: ${sess.user.restaurantId})`)
  return true
}

// ── Branches ──────────────────────────────────────────────────────────────────

const BRANCHES_TO_CREATE = [
  { name: 'Main Branch', code: 'MAIN', isMain: true },
  { name: 'Downtown', code: 'DT', isMain: false },
  { name: 'Airport', code: 'APT', isMain: false },
  { name: 'Mall', code: 'MALL', isMain: false },
]

async function seedBranches() {
  log('\n=== Seeding Branches ===')
  const existing = await apiGet('/api/restaurant/branches')
  const existingNames = new Set((Array.isArray(existing) ? existing : []).map(b => b.name))
  log(`Existing branches: ${existingNames.size > 0 ? [...existingNames].join(', ') : 'none'}`)

  for (const branch of BRANCHES_TO_CREATE) {
    if (existingNames.has(branch.name)) {
      log(`Skip: "${branch.name}" already exists`)
      continue
    }
    const result = await apiPost('/api/restaurant/branches', branch)
    if (result) log(`Created branch: "${branch.name}" (${branch.code})`)
  }
}

// ── Menu ──────────────────────────────────────────────────────────────────────

const MENU_ITEMS = [
  // Pizzas
  { name: 'Margherita Pizza', category: 'Pizza', sellingPrice: 12000 },
  { name: 'Pepperoni Pizza', category: 'Pizza', sellingPrice: 14000 },
  { name: 'BBQ Chicken Pizza', category: 'Pizza', sellingPrice: 15000 },
  { name: 'Vegetarian Pizza', category: 'Pizza', sellingPrice: 13000 },
  { name: 'Four Cheese Pizza', category: 'Pizza', sellingPrice: 16000 },

  // Salads
  { name: 'Caesar Salad', category: 'Salads', sellingPrice: 6500 },
  { name: 'Greek Salad', category: 'Salads', sellingPrice: 6000 },
  { name: 'Coleslaw', category: 'Salads', sellingPrice: 3500 },
  { name: 'Garden Salad', category: 'Salads', sellingPrice: 5000 },

  // Mains
  { name: 'Grilled Chicken', category: 'Mains', sellingPrice: 11000 },
  { name: 'Beef Burger', category: 'Mains', sellingPrice: 9500 },
  { name: 'Fish & Chips', category: 'Mains', sellingPrice: 10000 },
  { name: 'Pasta Carbonara', category: 'Mains', sellingPrice: 9000 },
  { name: 'Chicken Wings', category: 'Mains', sellingPrice: 8500 },

  // Sides
  { name: 'French Fries', category: 'Sides', sellingPrice: 3000 },
  { name: 'Onion Rings', category: 'Sides', sellingPrice: 3500 },
  { name: 'Garlic Bread', category: 'Sides', sellingPrice: 2500 },

  // Beer
  { name: 'Heineken (330ml)', category: 'Beer', sellingPrice: 2500 },
  { name: 'Guinness (500ml)', category: 'Beer', sellingPrice: 3500 },
  { name: 'Corona (330ml)', category: 'Beer', sellingPrice: 2800 },
  { name: 'Local Draft Beer', category: 'Beer', sellingPrice: 1500 },

  // Liquors & Cocktails
  { name: 'Whiskey (single)', category: 'Spirits', sellingPrice: 4500 },
  { name: 'Vodka Tonic', category: 'Spirits', sellingPrice: 3800 },
  { name: 'Rum & Coke', category: 'Spirits', sellingPrice: 3500 },

  // Soft Drinks
  { name: 'Soda (Coke/Fanta/Sprite)', category: 'Drinks', sellingPrice: 1000 },
]

async function seedMenu() {
  log('\n=== Seeding Menu (25 items) ===')
  const existing = await apiGet('/api/restaurant/dishes')
  const existingNames = new Set((Array.isArray(existing) ? existing : []).map(d => d.name))
  log(`Existing dishes: ${existingNames.size}`)

  let created = 0
  let skipped = 0
  for (const item of MENU_ITEMS) {
    if (existingNames.has(item.name)) {
      log(`Skip: "${item.name}" already exists`)
      skipped++
      continue
    }
    const result = await apiPost('/api/restaurant/dishes', item)
    if (result?.id || result?.dish?.id) {
      log(`Created: "${item.name}" (${item.category}) — ${item.sellingPrice.toLocaleString()}`)
      created++
    } else if (result) {
      log(`Created (no id): "${item.name}" — ${JSON.stringify(result).slice(0, 100)}`)
      created++
    }
    // Small delay to avoid hammering the API
    await new Promise(r => setTimeout(r, 200))
  }
  log(`Menu: ${created} created, ${skipped} skipped`)
}

// ── Enable dish tracking ──────────────────────────────────────────────────────

async function enableDishTracking() {
  log('\n=== Enabling Dish Tracking ===')
  const profile = await apiGet('/api/user/profile')
  if (profile?.trackingMode === 'dish_tracking') {
    log('Dish tracking already active')
    return
  }
  const result = await apiPatch('/api/user/profile', { trackingMode: 'dish_tracking' })
  if (result) log('Dish tracking enabled')
  else err('Failed to enable dish tracking')
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log('=== Restaurant Data Seeder ===')

  const ok = await login()
  if (!ok) {
    log('Login failed — aborting')
    process.exit(1)
  }

  await enableDishTracking()
  await seedBranches()
  await seedMenu()

  log(`\n=== Done (${errors.length} errors) ===`)
  if (errors.length > 0) {
    errors.forEach((e, i) => log(`  ${i + 1}. ${e}`))
  } else {
    log('All data seeded successfully!')
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
