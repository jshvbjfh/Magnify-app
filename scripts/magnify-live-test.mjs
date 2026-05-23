/**
 * Live UI test: drives Magnify through the full restaurant operation flow.
 * Bugs to catch: loading spinners that never resolve, broken modals, missing data.
 * Run: node scripts/magnify-live-test.mjs
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'fs'

const BASE = 'http://localhost:3001'
const MANAGER_EMAIL = 'testmanager@magnify.test'
const MANAGER_PASSWORD = 'Test1234!'
const SLOW_MO = 500

const bugs = []
function log(msg) { console.log(`[${new Date().toISOString()}] ${msg}`) }
function bug(msg) { bugs.push(msg); log(`🐛 BUG: ${msg}`) }

async function ss(page, name) {
  mkdirSync('scripts/screenshots', { recursive: true })
  await page.screenshot({ path: `scripts/screenshots/${name}.png`, fullPage: false })
  log(`Screenshot: ${name}`)
}

async function closeModal(page) {
  // Close any open modal with Escape key
  const modal = page.locator('.fixed.inset-0.z-50, [role="dialog"]').first()
  if (await modal.isVisible({ timeout: 500 }).catch(() => false)) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
  }
}

async function clickSidebar(page, label) {
  await closeModal(page)
  const el = page.locator(`aside button:has-text("${label}"), aside a:has-text("${label}")`).first()
  await el.waitFor({ timeout: 8000 })
  await el.click()
  await page.waitForTimeout(1200)
}

async function waitForContent(page, selector, label, timeoutMs = 8000) {
  const found = await page.waitForSelector(selector, { timeout: timeoutMs }).catch(() => null)
  if (!found) bug(`"${label}" content never loaded (selector: ${selector})`)
  return !!found
}

async function run() {
  const browser = await chromium.launch({
    headless: false,
    slowMo: SLOW_MO,
    executablePath: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  })
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()

  // Capture console errors from the page
  page.on('console', msg => { if (msg.type() === 'error') log(`[browser-error] ${msg.text()}`) })
  page.on('requestfailed', req => log(`[req-failed] ${req.url()} — ${req.failure()?.errorText}`))

  // ── 1. Login ──────────────────────────────────────────────────────────────
  log('=== STEP 1: Login ===')
  await page.goto(`${BASE}/login`)
  await page.waitForSelector('#email', { timeout: 15000 })
  await ss(page, '01-login')
  await page.fill('#email', MANAGER_EMAIL)
  await page.fill('#password', MANAGER_PASSWORD)
  await page.click('button[type="submit"]')
  await page.waitForFunction(() => !window.location.pathname.startsWith('/login'), { timeout: 25000 })
  await page.waitForLoadState('networkidle')
  log(`Landed: ${page.url()}`)
  await ss(page, '02-after-login')

  // ── 2. Enable Dish Tracking in Settings ──────────────────────────────────
  log('=== STEP 2: Settings — enable Dish Tracking ===')
  await clickSidebar(page, 'Settings')
  const settingsLoaded = await waitForContent(page, 'button:has-text("Dish Tracking")', 'Settings dish tracking buttons', 20000)
  await ss(page, '03-settings')
  if (!settingsLoaded) {
    bug('Settings page stuck on Loading — dish tracking button never appeared')
    // Force via API
    await page.evaluate(async () => {
      await fetch('/api/user/profile', {
        method: 'PUT', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackingMode: 'dish_tracking' }),
      }).catch(() => {})
    })
  } else {
    await page.locator('button:has-text("Dish Tracking")').first().click()
    await page.waitForTimeout(2000)
    await ss(page, '04-dish-tracking-enabled')
    log('Dish Tracking enabled')
  }

  // ── 3. Reload ─────────────────────────────────────────────────────────────
  log('=== STEP 3: Reload ===')
  await page.reload()
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(2000)
  await ss(page, '05-after-reload')

  // ── 4. Menu tab ───────────────────────────────────────────────────────────
  log('=== STEP 4: Menu tab ===')
  await clickSidebar(page, 'Menu')
  await ss(page, '06-menu-tab-loading')

  // Wait for menu content to load (either dishes list or empty state)
  const menuLoaded = await waitForContent(
    page,
    'button:has-text("Add Menu Item"), text=/no dishes/i, text=/empty/i, text=/get started/i, [class*="dish"], [class*="menu-item"]',
    'Menu content', 12000
  )
  await ss(page, '06b-menu-tab-loaded')

  // ── 5. Add a dish ─────────────────────────────────────────────────────────
  log('=== STEP 5: Add a dish ===')
  const addBtn = page.locator('button:has-text("Add Menu Item")').first()
  if (await addBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await addBtn.click()
    await page.waitForTimeout(800)
    await ss(page, '07-new-dish-modal')

    // Use exact placeholders from the form
    await page.getByPlaceholder('e.g. Grilled Tilapia').fill('Grilled Chicken')
    await page.getByPlaceholder('5000').fill('3500')
    await ss(page, '08-dish-form-filled')

    // Check VAT preview updated
    const vatPreview = await page.locator('text=/RWF/').first().textContent().catch(() => '')
    log(`VAT preview shows: ${vatPreview}`)

    await page.locator('button:has-text("Create Menu Item")').click()
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1000)
    await ss(page, '09-dish-saved')
    log('Dish submitted: Grilled Chicken @ 3500 RWF')
  } else {
    bug('Add Menu Item button not found on menu page')
    await ss(page, '07-no-add-button')
  }

  // ── 6. Orders tab ─────────────────────────────────────────────────────────
  log('=== STEP 6: Orders tab ===')
  await closeModal(page)
  await clickSidebar(page, 'Orders')
  await ss(page, '10-orders-loading')
  const ordersLoaded = await waitForContent(
    page,
    'text=/no orders/i, text=/empty/i, text=/pending/i, button:has-text("New Order"), [class*="order"]',
    'Orders content', 10000
  )
  await ss(page, '10b-orders-loaded')

  // ── 7. Tables ─────────────────────────────────────────────────────────────
  log('=== STEP 7: Tables tab ===')
  await clickSidebar(page, 'Tables')
  await page.waitForTimeout(2000)
  await ss(page, '11-tables')

  // ── 8. Live View ──────────────────────────────────────────────────────────
  log('=== STEP 8: Live View ===')
  await clickSidebar(page, 'Live View')
  await page.waitForTimeout(2000)
  await ss(page, '12-live-view')

  // ── 9. Inventory ──────────────────────────────────────────────────────────
  log('=== STEP 9: Inventory ===')
  await clickSidebar(page, 'Inventory')
  await page.waitForTimeout(2000)
  await ss(page, '13-inventory')

  // ── 10. Reports ───────────────────────────────────────────────────────────
  log('=== STEP 10: Reports ===')
  await clickSidebar(page, 'Reports')
  await page.waitForTimeout(2500)
  await ss(page, '14-reports')

  // ── 11. Transactions ──────────────────────────────────────────────────────
  log('=== STEP 11: Transactions ===')
  await clickSidebar(page, 'Transactions')
  await page.waitForTimeout(1500)
  await ss(page, '15-transactions')

  // ── Summary ───────────────────────────────────────────────────────────────
  log(`\n=== BUG REPORT (${bugs.length} bugs) ===`)
  bugs.forEach((b, i) => log(`  ${i + 1}. ${b}`))
  if (bugs.length === 0) log('  No bugs detected!')

  log('\nKeeping browser open 5 min for inspection...')
  await page.waitForTimeout(5 * 60 * 1000).catch(() => {})
  await browser.close()
}

run().catch(err => { console.error('FAILED:', err.message); process.exit(1) })
