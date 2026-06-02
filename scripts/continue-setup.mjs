/**
 * Continuation: adds remaining menu items + tables.
 * Reads the screen at every step. Injects HTTP session cookie.
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'fs'

const BASE = 'http://localhost:3001'
const EMAIL = 'testmanager@magnify.test'
const PASSWORD = 'Test1234!'
const CHROMIUM = 'C:\\Users\\HP\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe'
const SS_DIR = 'scripts/screenshots/cont'
mkdirSync(SS_DIR, { recursive: true })

let ssCount = 0
const log = msg => console.log(`[${new Date().toISOString()}] ${msg}`)
async function shot(page, label) {
  const path = `${SS_DIR}/${String(++ssCount).padStart(2,'0')}-${label}.png`
  await page.screenshot({ path, fullPage: false })
  log(`📸 ${label}`)
  return path
}

// HTTP login → session cookie
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
  if (!jar['next-auth.session-token']) throw new Error('Login failed — no session token')
  log('Logged in via HTTP ✓')
  return jar
}

// Wait for a sidebar button to appear (sidebar loads async after client fetches profile)
async function waitSidebar(page, label, timeoutMs = 15000) {
  const btn = page.locator('aside nav button').filter({ hasText: new RegExp(`^${label}$`) }).first()
  await btn.waitFor({ state: 'visible', timeout: timeoutMs })
  return btn
}

async function run() {
  const cookieJar = await httpLogin()

  const browser = await chromium.launch({ headless: false, slowMo: 150, executablePath: CHROMIUM })
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await ctx.addCookies(Object.entries(cookieJar).map(([name, value]) => ({
    name, value, domain: 'localhost', path: '/', httpOnly: false, secure: false, sameSite: 'Lax',
  })))

  const page = await ctx.newPage()
  page.on('response', r => { if (r.url().includes('/api/') && r.status() >= 400) log(`[${r.status()}] ${r.url()}`) })

  // ── Navigate to restaurant ─────────────────────────────────────────────────
  await page.goto(`${BASE}/restaurant`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(4000)
  await shot(page, 'start')
  log(`URL: ${page.url()}`)

  // ── MENU: Add missing dishes ───────────────────────────────────────────────
  log('\n=== STEP: Menu ===')
  const menuBtn = await waitSidebar(page, 'Menu').catch(() => null)
  if (!menuBtn) {
    log('Menu not in sidebar yet — reloading...')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(4000)
  }
  const menuBtn2 = await waitSidebar(page, 'Menu', 12000).catch(() => null)
  if (!menuBtn2) { log('ERROR: Menu never appeared'); await shot(page, 'no-menu'); await browser.close(); return }

  await menuBtn2.click()
  await page.waitForTimeout(2000)
  await shot(page, 'menu-page')

  // Read current dish count from screen
  const menuHeading = await page.locator('text=/Menu Items \\(\\d+\\)/').first().innerText().catch(() => '')
  log(`Screen shows: ${menuHeading}`)

  // Dishes to add — try all, skip if modal stays open (duplicate/error)
  const DISHES_TO_ADD = [
    { name: 'Grilled Chicken', category: 'Mains', price: '11000' },
    { name: 'Beef Burger', category: 'Mains', price: '9500' },
    { name: 'Fish and Chips', category: 'Mains', price: '10000' },
    { name: 'Pasta Carbonara', category: 'Mains', price: '9000' },
    { name: 'Chicken Wings', category: 'Mains', price: '8500' },
    { name: 'French Fries', category: 'Sides', price: '3000' },
    { name: 'Onion Rings', category: 'Sides', price: '3500' },
    { name: 'Garlic Bread', category: 'Sides', price: '2500' },
    { name: 'Heineken 330ml', category: 'Beer', price: '2500' },
    { name: 'Guinness 500ml', category: 'Beer', price: '3500' },
  ]

  for (const dish of DISHES_TO_ADD) {
    log(`\nAdding: ${dish.name}`)

    // Close any stray modal from a previous failed attempt
    const stray = page.locator('div.fixed.inset-0.z-50').first()
    if (await stray.isVisible({ timeout: 300 }).catch(() => false)) {
      await page.keyboard.press('Escape')
      await stray.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {})
      await page.waitForTimeout(200)
    }

    // The button text from the screenshot is "+ Add Menu Item"
    const addBtn = page.locator('button').filter({ hasText: /Add Menu Item/i }).first()
    await addBtn.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
    if (!await addBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      log(`Add button not visible — screenshot`)
      await shot(page, `no-add-${dish.name.replace(/\s/g,'-')}`)
      continue
    }

    await addBtn.click()
    await page.waitForTimeout(700)

    // Verify modal opened
    const modal = page.locator('div.fixed.inset-0').first()
    if (!await modal.isVisible({ timeout: 4000 }).catch(() => false)) {
      log('No modal — skip')
      continue
    }

    // Fill name field (placeholder: "e.g. Grilled Tilapia")
    const nameField = page.getByPlaceholder('e.g. Grilled Tilapia')
    await nameField.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {})
    await nameField.fill(dish.name)

    // Fill price (placeholder: "5000")
    const priceField = page.getByPlaceholder('5000')
    if (await priceField.isVisible({ timeout: 1000 }).catch(() => false)) await priceField.fill(dish.price)

    // Fill category
    const catField = page.locator('input[placeholder*="ategor" i]').first()
    if (await catField.isVisible({ timeout: 1000 }).catch(() => false)) await catField.fill(dish.category)

    await shot(page, `form-${dish.name.replace(/\s/g,'-')}`)

    // Click submit button inside modal
    const submitBtn = page.locator('div.fixed.inset-0 button[type="submit"]').first()
    if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await submitBtn.click()
    } else {
      const createBtn = page.locator('button').filter({ hasText: /Create Menu Item|Save Changes/i }).first()
      if (await createBtn.isVisible({ timeout: 1000 }).catch(() => false)) await createBtn.click()
      else { log('No submit button found'); await page.keyboard.press('Escape'); continue }
    }

    // Wait for modal to close (success) or stay open (error/duplicate)
    const closed = await page.locator('div.fixed.inset-0.z-50').first()
      .waitFor({ state: 'hidden', timeout: 10000 }).then(() => true).catch(() => false)

    if (closed) {
      log(`✓ Added: ${dish.name}`)
      await page.waitForTimeout(400)
    } else {
      const modalText = await modal.innerText().catch(() => '')
      log(`✗ ${dish.name} — modal stayed open (likely duplicate). Closing...`)
      // Force-close the modal — try Escape first, then click outside it
      await page.keyboard.press('Escape')
      await page.locator('div.fixed.inset-0.z-50').first()
        .waitFor({ state: 'hidden', timeout: 4000 }).catch(async () => {
          // If Escape didn't work, click the backdrop
          await page.locator('div.fixed.inset-0').first().click({ position: { x: 10, y: 10 } }).catch(() => {})
          await page.waitForTimeout(500)
        })
      await page.waitForTimeout(300)
    }
  }

  // Make sure no modal overlay is left open before moving on
  const strayModal = page.locator('div.fixed.inset-0.z-50').first()
  if (await strayModal.isVisible({ timeout: 500 }).catch(() => false)) {
    await page.keyboard.press('Escape')
    await strayModal.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {})
  }

  await shot(page, 'menu-final')
  const finalHeading = await page.locator('text=/Menu Items \\(\\d+\\)/').first().innerText().catch(() => '?')
  log(`\nFinal menu count: ${finalHeading}`)

  // ── TABLES: Add Table 1–5 ──────────────────────────────────────────────────
  log('\n=== STEP: Tables ===')
  const tablesBtn = await waitSidebar(page, 'Tables').catch(() => null)
  if (!tablesBtn) { log('No Tables button'); await shot(page, 'no-tables') }
  else {
    await tablesBtn.click()
    await page.waitForTimeout(2500)
    await shot(page, 'tables-page')

    for (let i = 1; i <= 5; i++) {
      log(`Adding Table ${i}...`)

      // Click "+ Add Table" button (top right from screenshot)
      const addTableBtn = page.locator('button').filter({ hasText: /Add Table/ }).first()
      await addTableBtn.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {})
      if (!await addTableBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        log('No Add Table button'); break
      }
      await addTableBtn.click()
      await page.waitForTimeout(600)

      await shot(page, `table-form-${i}`)

      // Read the form — find ALL visible text inputs and fill the first one
      const inputs = page.locator('input[type="text"], input:not([type])').filter({ visible: true })
      const count = await inputs.count()
      log(`Form has ${count} visible text inputs`)

      if (count > 0) {
        const firstInput = inputs.first()
        const placeholder = await firstInput.getAttribute('placeholder').catch(() => '')
        log(`First input placeholder: "${placeholder}"`)
        await firstInput.fill(`Table ${i}`)
        await page.waitForTimeout(300)
      } else {
        log('No text input found in table form')
        await shot(page, `table-no-input-${i}`)
        await page.keyboard.press('Escape')
        continue
      }

      // Now the Add Table button should be enabled — click it
      // Wait briefly for it to enable after typing
      await page.waitForTimeout(300)

      // Find the enabled submit/confirm button
      const confirmBtn = page.locator('button[type="submit"]').or(
        page.locator('button').filter({ hasText: /^Add Table$/ })
      ).filter({ visible: true }).last()

      const isEnabled = await confirmBtn.isEnabled({ timeout: 2000 }).catch(() => false)
      log(`Confirm button enabled: ${isEnabled}`)

      if (isEnabled) {
        await confirmBtn.click()
      } else {
        // Try pressing Enter in the input
        await inputs.first().press('Enter')
      }

      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
      await page.waitForTimeout(1200)
      await shot(page, `table-${i}-added`)

      const tableText = await page.locator('main, .main-content, [data-testid="main"]').innerText().catch(
        () => page.innerText('body').catch(() => '')
      )
      log(`After adding table ${i}: ${tableText.slice(0, 200)}`)
    }
    await shot(page, 'tables-final')
  }

  // ── ORDERS: Place a test order ─────────────────────────────────────────────
  log('\n=== STEP: Orders ===')
  const ordersBtn = await waitSidebar(page, 'Orders').catch(() => null)
  if (!ordersBtn) { log('No Orders button') }
  else {
    await ordersBtn.click()
    await page.waitForTimeout(2500)
    await shot(page, 'orders-page')

    const ordersText = await page.innerText('body').catch(() => '')
    log(`Orders page: ${ordersText.slice(0, 400)}`)

    // Click Table 1
    const table1 = page.locator('button').filter({ hasText: /^Table 1$/ }).first()
    if (await table1.isVisible({ timeout: 6000 }).catch(() => false)) {
      await table1.click()
      await page.waitForTimeout(1200)
      await shot(page, 'table1-selected')

      // Add Margherita Pizza
      const pizza = page.locator('button').filter({ hasText: /Margherita/i }).first()
      if (await pizza.isVisible({ timeout: 5000 }).catch(() => false)) {
        await pizza.click()
        await page.waitForTimeout(400)
        log('Added Margherita Pizza')
      }

      // Add Grilled Chicken
      const chicken = page.locator('button').filter({ hasText: /Grilled Chicken/i }).first()
      if (await chicken.isVisible({ timeout: 3000 }).catch(() => false)) {
        await chicken.click()
        await page.waitForTimeout(400)
        log('Added Grilled Chicken')
      }

      await shot(page, 'order-items')

      // Confirm order
      const confirmOrder = page.locator('button').filter({ hasText: /Confirm order|Place Order|Submit/i }).first()
      if (await confirmOrder.isVisible({ timeout: 5000 }).catch(() => false)) {
        await confirmOrder.click()
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
        await page.waitForTimeout(2000)
        await shot(page, 'order-placed')
        log('Order placed!')
      } else {
        await shot(page, 'no-confirm-btn')
        const btnText = await page.locator('button').allInnerTexts().catch(() => [])
        log(`Visible buttons: ${btnText.filter(t => t.trim()).join(' | ')}`)
      }
    } else {
      log('Table 1 not found')
      await shot(page, 'no-table1')
    }
  }

  log('\n=== Done — browser stays open for 10 min ===')
  await page.waitForTimeout(10 * 60 * 1000).catch(() => {})
  await browser.close()
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
