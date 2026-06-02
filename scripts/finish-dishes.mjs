/**
 * Adds remaining menu items via HTTP API (skipping duplicates),
 * then opens browser for Tables + Orders.
 */
import { chromium } from 'playwright'
import { readFileSync } from 'fs'
import { mkdirSync } from 'fs'

const SS_DIR = 'scripts/screenshots/finish'
mkdirSync(SS_DIR, { recursive: true })

// Load .env.local manually so we can also use this for reference
const envLines = readFileSync('.env.local', 'utf8').split('\n')
const env = {}
envLines.forEach(line => {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return
  const eq = trimmed.indexOf('=')
  if (eq < 0) return
  const k = trimmed.slice(0, eq).trim()
  const v = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
  env[k] = v
})

const BASE = 'http://localhost:3001'
const EMAIL = 'testmanager@magnify.test'
const PASSWORD = 'Test1234!'
const CHROMIUM = 'C:\\Users\\HP\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe'

let ssCount = 0
const log = msg => console.log(`[${new Date().toISOString()}] ${msg}`)
async function shot(page, label) {
  const path = `${SS_DIR}/${String(++ssCount).padStart(2,'0')}-${label}.png`
  await page.screenshot({ path, fullPage: false })
  log(`📸 ${label}`)
}

// HTTP auth
async function httpLogin() {
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
  if (!jar['next-auth.session-token']) throw new Error('Login failed')
  return jar
}

async function apiGet(path, cookie) {
  const r = await fetch(`${BASE}${path}`, { headers: { Cookie: cookie } })
  return r.ok ? r.json() : null
}

async function apiPost(path, body, cookie) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  return { ok: r.ok, status: r.status, data: text }
}

// All 25 target dishes
const ALL_DISHES = [
  { name: 'Margherita Pizza', category: 'Pizza', sellingPrice: 12000 },
  { name: 'Pepperoni Pizza', category: 'Pizza', sellingPrice: 14000 },
  { name: 'BBQ Chicken Pizza', category: 'Pizza', sellingPrice: 15000 },
  { name: 'Vegetarian Pizza', category: 'Pizza', sellingPrice: 13000 },
  { name: 'Four Cheese Pizza', category: 'Pizza', sellingPrice: 16000 },
  { name: 'Caesar Salad', category: 'Salads', sellingPrice: 6500 },
  { name: 'Greek Salad', category: 'Salads', sellingPrice: 6000 },
  { name: 'Coleslaw', category: 'Salads', sellingPrice: 3500 },
  { name: 'Garden Salad', category: 'Salads', sellingPrice: 5000 },
  { name: 'Grilled Chicken', category: 'Mains', sellingPrice: 11000 },
  { name: 'Beef Burger', category: 'Mains', sellingPrice: 9500 },
  { name: 'Fish and Chips', category: 'Mains', sellingPrice: 10000 },
  { name: 'Pasta Carbonara', category: 'Mains', sellingPrice: 9000 },
  { name: 'Chicken Wings', category: 'Mains', sellingPrice: 8500 },
  { name: 'French Fries', category: 'Sides', sellingPrice: 3000 },
  { name: 'Onion Rings', category: 'Sides', sellingPrice: 3500 },
  { name: 'Garlic Bread', category: 'Sides', sellingPrice: 2500 },
  { name: 'Heineken 330ml', category: 'Beer', sellingPrice: 2500 },
  { name: 'Guinness 500ml', category: 'Beer', sellingPrice: 3500 },
  { name: 'Corona 330ml', category: 'Beer', sellingPrice: 2800 },
  { name: 'Local Draft Beer', category: 'Beer', sellingPrice: 1500 },
  { name: 'Whiskey Single', category: 'Spirits', sellingPrice: 4500 },
  { name: 'Vodka Tonic', category: 'Spirits', sellingPrice: 3800 },
  { name: 'Rum and Coke', category: 'Spirits', sellingPrice: 3500 },
  { name: 'Soda', category: 'Drinks', sellingPrice: 1000 },
]

async function run() {
  log('=== HTTP login ===')
  const cookieJar = await httpLogin()
  const cookie = Object.entries(cookieJar).map(([k,v]) => `${k}=${v}`).join('; ')

  // Check existing dishes
  log('Fetching existing dishes...')
  const existing = await apiGet('/api/restaurant/dishes', cookie)
  const existingNames = new Set((Array.isArray(existing) ? existing : []).map(d => d.name))
  log(`Existing dishes: ${existingNames.size} — ${[...existingNames].join(', ')}`)

  // Add missing dishes via HTTP
  const missing = ALL_DISHES.filter(d => !existingNames.has(d.name))
  log(`\nMissing: ${missing.length} dishes — ${missing.map(d => d.name).join(', ')}`)

  let added = 0
  for (const dish of missing) {
    const result = await apiPost('/api/restaurant/dishes', dish, cookie)
    if (result.ok) {
      log(`✓ Added: ${dish.name}`)
      added++
    } else if (result.status === 500 && result.data.includes('Unique constraint')) {
      log(`⚠ Skip (duplicate): ${dish.name}`)
    } else {
      log(`✗ FAILED: ${dish.name} → ${result.status}: ${result.data.slice(0, 100)}`)
    }
    // Small delay
    await new Promise(r => setTimeout(r, 300))
  }

  // Verify final count
  const finalDishes = await apiGet('/api/restaurant/dishes', cookie)
  log(`\nFinal dish count: ${Array.isArray(finalDishes) ? finalDishes.length : '?'} / 25`)

  // ── BROWSER: Tables + Orders ───────────────────────────────────────────────
  log('\n=== Opening browser for Tables + Orders ===')
  const browser = await chromium.launch({ headless: false, slowMo: 200, executablePath: CHROMIUM })
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await ctx.addCookies(Object.entries(cookieJar).map(([name, value]) => ({
    name, value, domain: 'localhost', path: '/', httpOnly: false, secure: false, sameSite: 'Lax',
  })))
  const page = await ctx.newPage()
  page.on('response', r => { if (r.url().includes('/api/') && r.status() >= 400) log(`[${r.status()}] ${r.url()}`) })

  await page.goto(`${BASE}/restaurant`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(3000)
  await shot(page, 'start')

  // ── TABLES ─────────────────────────────────────────────────────────────────
  log('\n=== Tables ===')
  const tablesBtn = page.locator('aside nav button').filter({ hasText: /^Tables$/ }).first()
  await tablesBtn.waitFor({ state: 'visible', timeout: 15000 })
  await tablesBtn.click()
  await page.waitForTimeout(2000)
  await shot(page, 'tables-page')

  // Check existing tables
  const tablesText = await page.innerText('body').catch(() => '')
  log(`Tables page: ${tablesText.slice(0, 300)}`)

  for (let i = 1; i <= 5; i++) {
    // Check if table already exists
    const tableExists = await page.locator(`text=/Table ${i}/`).first().isVisible({ timeout: 1000 }).catch(() => false)
    if (tableExists) { log(`Table ${i} already exists — skip`); continue }

    const addTableBtn = page.locator('button').filter({ hasText: /Add Table/ }).first()
    await addTableBtn.waitFor({ state: 'visible', timeout: 5000 })
    await addTableBtn.click()
    await page.waitForTimeout(700)
    await shot(page, `table-form-${i}`)

    // Fill ALL text inputs with the table name
    const allInputs = await page.locator('input[type="text"], input:not([type="hidden"]):not([type="submit"]):not([type="button"])').all()
    log(`Form inputs found: ${allInputs.length}`)
    for (const inp of allInputs) {
      if (await inp.isVisible().catch(() => false)) {
        const ph = await inp.getAttribute('placeholder').catch(() => '')
        log(`  Input placeholder: "${ph}"`)
        await inp.fill(`Table ${i}`)
        break
      }
    }
    await page.waitForTimeout(400)

    // Click enabled submit button
    const btns = await page.locator('button').all()
    for (const btn of btns) {
      const text = await btn.innerText().catch(() => '')
      const enabled = await btn.isEnabled().catch(() => false)
      const visible = await btn.isVisible().catch(() => false)
      if (visible && enabled && /Add Table|Confirm|Save|Create/i.test(text)) {
        log(`Clicking: "${text.trim()}"`)
        await btn.click()
        break
      }
    }

    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(1200)
    await shot(page, `table-${i}-done`)
    log(`Table ${i} added`)
  }
  await shot(page, 'tables-final')

  // ── ORDERS: place a test order ─────────────────────────────────────────────
  log('\n=== Orders ===')
  const ordersBtn = page.locator('aside nav button').filter({ hasText: /^Orders$/ }).first()
  await ordersBtn.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {})
  if (await ordersBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await ordersBtn.click()
    await page.waitForTimeout(2500)
    await shot(page, 'orders-page')

    // Read what's on orders page
    const ordText = await page.innerText('body').catch(() => '')
    log(`Orders page content: ${ordText.slice(0, 500)}`)

    // Click Table 1
    const tbl1 = page.locator('button').filter({ hasText: /^Table 1$/ }).first()
    if (await tbl1.isVisible({ timeout: 6000 }).catch(() => false)) {
      await tbl1.click()
      await page.waitForTimeout(1500)
      await shot(page, 'table1-selected')

      // Read orders panel
      const panelText = await page.innerText('body').catch(() => '')
      log(`After table select: ${panelText.slice(0, 400)}`)

      // Click first visible dish
      const dishBtns = await page.locator('button').filter({ hasText: /Margherita|Pepperoni|Grilled|Caesar/i }).all()
      if (dishBtns.length > 0) {
        const first = dishBtns[0]
        const dishName = await first.innerText().catch(() => '?')
        await first.click()
        await page.waitForTimeout(500)
        log(`Added to order: ${dishName}`)

        if (dishBtns.length > 1) {
          const second = dishBtns[1]
          const name2 = await second.innerText().catch(() => '?')
          await second.click()
          await page.waitForTimeout(500)
          log(`Added to order: ${name2}`)
        }
      }
      await shot(page, 'order-items')

      // Find confirm button — read all button texts first
      const allBtnTexts = await page.locator('button').allInnerTexts()
      log(`Buttons visible: ${allBtnTexts.filter(t => t.trim()).join(' | ')}`)

      const confirmBtn = page.locator('button').filter({ hasText: /Confirm order|Place Order|Submit order/i }).first()
      if (await confirmBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
        await confirmBtn.click()
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
        await page.waitForTimeout(2000)
        await shot(page, 'order-placed')
        log('✓ Order placed!')
      } else {
        await shot(page, 'no-confirm')
        log('Confirm button not found')
      }
    } else {
      log('Table 1 not found on orders page')
      await shot(page, 'no-table1')
    }
  }

  log('\n=== All done! Browser stays open — press Ctrl+C to exit ===')
  await page.waitForTimeout(10 * 60 * 1000).catch(() => {})
  await browser.close()
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
