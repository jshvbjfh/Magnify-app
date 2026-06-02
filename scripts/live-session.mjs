/**
 * Live interactive session — reads the screen at each step and adapts.
 * Uses HTTP login to get a valid session cookie, then injects into browser.
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'fs'

const BASE = 'http://localhost:3001'
const EMAIL = 'testmanager@magnify.test'
const PASSWORD = 'Test1234!'
const CHROMIUM = 'C:\\Users\\HP\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe'
const SS_DIR = 'scripts/screenshots/live'

mkdirSync(SS_DIR, { recursive: true })

const log = msg => console.log(`[${new Date().toISOString()}] ${msg}`)

let ssCount = 0
async function shot(page, label) {
  const name = `${String(++ssCount).padStart(2,'0')}-${label}`
  const path = `${SS_DIR}/${name}.png`
  await page.screenshot({ path, fullPage: false })
  log(`SCREENSHOT: ${name}`)
  return path
}

// ── Step 1: HTTP login to get a real session cookie ───────────────────────────
async function httpLogin() {
  log('Getting CSRF token...')
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`)
  const csrfCookies = csrfRes.headers.getSetCookie?.() ?? []
  const { csrfToken } = await csrfRes.json()

  const jar = {}
  csrfCookies.forEach(c => {
    const kv = c.split(';')[0].trim()
    const eq = kv.indexOf('=')
    if (eq > 0) jar[kv.slice(0, eq)] = kv.slice(eq + 1)
  })

  const csrfCookieStr = Object.entries(jar).map(([k,v]) => `${k}=${v}`).join('; ')

  log('Logging in via HTTP...')
  const loginRes = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: csrfCookieStr,
    },
    body: new URLSearchParams({ csrfToken, email: EMAIL, password: PASSWORD, callbackUrl: `${BASE}/restaurant`, json: 'true' }).toString(),
    redirect: 'manual',
  })

  const loginCookies = loginRes.headers.getSetCookie?.() ?? []
  loginCookies.forEach(c => {
    const kv = c.split(';')[0].trim()
    const eq = kv.indexOf('=')
    if (eq > 0) jar[kv.slice(0, eq)] = kv.slice(eq + 1)
  })

  if (!jar['next-auth.session-token']) {
    throw new Error('No session token received from HTTP login')
  }
  log(`Session token obtained (${Object.keys(jar).join(', ')})`)
  return jar
}

// ── Step 2: Inject cookies into Playwright and navigate ───────────────────────
async function run() {
  const cookieJar = await httpLogin()

  const browser = await chromium.launch({
    headless: false,
    slowMo: 200,
    executablePath: CHROMIUM,
  })

  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })

  // Inject session cookies so browser is already authenticated
  const playwrightCookies = Object.entries(cookieJar).map(([name, value]) => ({
    name, value, domain: 'localhost', path: '/', httpOnly: false, secure: false, sameSite: 'Lax',
  }))
  await ctx.addCookies(playwrightCookies)
  log('Cookies injected into browser context')

  const page = await ctx.newPage()
  page.on('response', r => {
    if (r.url().includes('/api/') && r.status() >= 400)
      log(`[API ${r.status()}] ${r.url()}`)
  })

  // ── Navigate to restaurant ─────────────────────────────────────────────────
  log('Navigating to /restaurant...')
  await page.goto(`${BASE}/restaurant`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(3000)
  await shot(page, 'restaurant-home')

  // Check if we're on login page
  if (page.url().includes('/login')) {
    log('Still on login page — session cookie not working, trying manual login...')
    await page.fill('#email', EMAIL).catch(() => {})
    await page.fill('#password', PASSWORD).catch(() => {})
    await page.click('button[type="submit"]').catch(() => {})
    await page.waitForTimeout(5000)
    await shot(page, 'after-manual-login')
  }

  log(`Current URL: ${page.url()}`)

  // Check what's on screen
  const pageText = await page.innerText('body').catch(() => '')
  log(`Page contains: ${pageText.slice(0, 300)}`)

  // ── Navigate to Menu ───────────────────────────────────────────────────────
  log('\n=== Going to Menu ===')
  const menuBtn = page.locator('aside nav button').filter({ hasText: /^Menu$/ }).first()
  if (await menuBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
    await menuBtn.click()
    await page.waitForTimeout(2000)
    await shot(page, 'menu-page')

    // Read what's on the menu page
    const menuText = await page.innerText('body').catch(() => '')
    log(`Menu page: ${menuText.slice(0, 500)}`)
  } else {
    log('Menu button not found — reading sidebar...')
    const sidebar = await page.locator('aside').innerText().catch(() => 'no sidebar')
    log(`Sidebar content: ${sidebar.slice(0, 300)}`)
    await shot(page, 'no-menu-btn')
  }

  // ── Add remaining menu items ───────────────────────────────────────────────
  const REMAINING_MENU = [
    // Mains
    { name: 'Grilled Chicken', category: 'Mains', price: '11000' },
    { name: 'Beef Burger', category: 'Mains', price: '9500' },
    { name: 'Fish and Chips', category: 'Mains', price: '10000' },
    { name: 'Pasta Carbonara', category: 'Mains', price: '9000' },
    { name: 'Chicken Wings', category: 'Mains', price: '8500' },
    // Sides
    { name: 'French Fries', category: 'Sides', price: '3000' },
    { name: 'Onion Rings', category: 'Sides', price: '3500' },
    { name: 'Garlic Bread', category: 'Sides', price: '2500' },
    // Beer
    { name: 'Heineken 330ml', category: 'Beer', price: '2500' },
    { name: 'Guinness 500ml', category: 'Beer', price: '3500' },
    { name: 'Corona 330ml', category: 'Beer', price: '2800' },
    { name: 'Local Draft Beer', category: 'Beer', price: '1500' },
    // Spirits
    { name: 'Whiskey Single', category: 'Spirits', price: '4500' },
    { name: 'Vodka Tonic', category: 'Spirits', price: '3800' },
    { name: 'Rum and Coke', category: 'Spirits', price: '3500' },
    // Drinks
    { name: 'Soda', category: 'Drinks', price: '1000' },
  ]

  for (const item of REMAINING_MENU) {
    log(`\nAdding: ${item.name}`)

    // Find and click the Add button
    const addBtn = page.locator('button').filter({ hasText: /Add Menu Item|Add Dish|New Dish|\+ Add/i }).first()
    if (!await addBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      log(`Add button not visible — taking screenshot to see what's on screen`)
      await shot(page, `no-add-btn-before-${item.name.replace(/\s+/g,'-')}`)
      // Try navigating to menu again
      const m = page.locator('aside nav button').filter({ hasText: /^Menu$/ }).first()
      if (await m.isVisible({ timeout: 3000 }).catch(() => false)) await m.click()
      await page.waitForTimeout(1500)
    }

    if (!await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      log(`Still no add button — skipping ${item.name}`)
      continue
    }

    await addBtn.click()
    await page.waitForTimeout(800)

    // Read the modal
    const modalVisible = await page.locator('div[role="dialog"], div.fixed.inset-0').first()
      .isVisible({ timeout: 4000 }).catch(() => false)
    if (!modalVisible) {
      await shot(page, `no-modal-${item.name.replace(/\s+/g,'-')}`)
      log('No modal appeared')
      continue
    }

    // Fill name field
    const nameField = page.getByPlaceholder('e.g. Grilled Tilapia').or(page.getByPlaceholder(/dish name|item name/i))
    if (await nameField.isVisible({ timeout: 2000 }).catch(() => false)) {
      await nameField.fill(item.name)
    } else {
      // Take screenshot of modal to see what fields exist
      await shot(page, `modal-fields-${item.name.replace(/\s+/g,'-')}`)
      const modalText = await page.locator('div.fixed.inset-0').first().innerText().catch(() => '')
      log(`Modal content: ${modalText.slice(0, 300)}`)
      await page.keyboard.press('Escape')
      continue
    }

    // Fill price
    const priceField = page.getByPlaceholder('5000').or(page.getByPlaceholder(/price/i))
    if (await priceField.isVisible({ timeout: 1000 }).catch(() => false)) {
      await priceField.fill(item.price)
    }

    // Fill category
    const catField = page.locator('input[placeholder*="category" i], input[placeholder*="Category" i]').first()
    if (await catField.isVisible({ timeout: 1000 }).catch(() => false)) {
      await catField.fill(item.category)
    }

    // Submit
    const submitBtn = page.locator('div.fixed.inset-0 button[type="submit"], div[role="dialog"] button[type="submit"]').first()
    if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await submitBtn.click()
    } else {
      const createBtn = page.locator('button').filter({ hasText: /Create Menu Item|Save|Add Dish/i }).first()
      if (await createBtn.isVisible({ timeout: 1000 }).catch(() => false)) await createBtn.click()
    }

    // Wait for modal to close
    const closed = await page.locator('div.fixed.inset-0.z-50').first()
      .waitFor({ state: 'hidden', timeout: 10000 })
      .then(() => true).catch(() => false)

    if (closed) {
      log(`✓ Added: ${item.name}`)
      await page.waitForTimeout(500)
    } else {
      // Read the modal to see error
      const modalErr = await page.locator('div.fixed.inset-0').first().innerText().catch(() => '')
      log(`Modal still open — error? ${modalErr.slice(0, 200)}`)
      await shot(page, `modal-error-${item.name.replace(/\s+/g,'-')}`)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(500)
    }
  }

  await shot(page, 'menu-complete')
  log('\n=== Menu complete — reading final state ===')
  const finalText = await page.innerText('body').catch(() => '')
  log(`Final page: ${finalText.slice(0, 400)}`)

  // ── Navigate to Tables ─────────────────────────────────────────────────────
  log('\n=== Going to Tables ===')
  const tablesBtn = page.locator('aside nav button').filter({ hasText: /^Tables$/ }).first()
  if (await tablesBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await tablesBtn.click()
    await page.waitForTimeout(2000)
    await shot(page, 'tables-page')

    // Read tables page
    const tablesText = await page.innerText('body').catch(() => '')
    log(`Tables page: ${tablesText.slice(0, 400)}`)

    // Add tables 1-5
    for (let i = 1; i <= 5; i++) {
      const addTableBtn = page.locator('button').filter({ hasText: /^Add Table$/ }).first()
      if (!await addTableBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        log('No Add Table button')
        await shot(page, 'no-add-table-btn')
        break
      }
      await addTableBtn.click()
      await page.waitForTimeout(600)

      const nameInput = page.locator('input').filter({ hasText: /table|name/i }).or(page.locator('input[type="text"]')).first()
      if (await nameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        await nameInput.fill(`Table ${i}`)
      }

      // Confirm
      const confirmBtn = page.locator('button').filter({ hasText: /^Add Table$|^Confirm$|^Save$/ }).last()
      if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await confirmBtn.click()
      }
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
      await page.waitForTimeout(1000)
      log(`Added Table ${i}`)
    }
    await shot(page, 'tables-complete')
  } else {
    log('Tables button not found')
    await shot(page, 'no-tables-btn')
  }

  log('\n=== Session complete — browser stays open for inspection ===')
  log('Press Ctrl+C to close when done.')
  await page.waitForTimeout(10 * 60 * 1000).catch(() => {})
  await browser.close()
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
