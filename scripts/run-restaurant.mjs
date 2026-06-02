/**
 * Full operational restaurant walkthrough.
 * Goal: create a working restaurant from scratch — menu, tables, orders, payment.
 * Run: node scripts/run-restaurant.mjs
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'fs'

const BASE = 'http://localhost:3001'
const EMAIL = 'testmanager@magnify.test'
const PASSWORD = 'Test1234!'
const CHROMIUM = 'C:\\Users\\HP\\AppData\\Local\\ms-playwright\\chromium-1223\\chrome-win64\\chrome.exe'
const SS_DIR = 'scripts/screenshots/run'

const log = msg => console.log(`[${new Date().toISOString()}] ${msg}`)
const bugs = []
const bug = msg => { bugs.push(msg); log(`BUG: ${msg}`) }

async function ss(page, name) {
  mkdirSync(SS_DIR, { recursive: true })
  await page.screenshot({ path: `${SS_DIR}/${name}.png`, fullPage: false })
  log(`SS: ${name}`)
}

/** Click a sidebar nav button by its exact label */
async function sidebar(page, label) {
  // Dismiss any open modal first
  const modal = page.locator('div.fixed.inset-0.z-50').first()
  if (await modal.isVisible({ timeout: 300 }).catch(() => false)) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(600)
  }
  const btn = page.locator('aside nav button').filter({ hasText: label }).first()
  await btn.waitFor({ state: 'visible', timeout: 10000 })
  await btn.click()
  await page.waitForTimeout(1200)
}

/** Wait for the modal to disappear after form submission */
async function waitModalGone(page, timeoutMs = 8000) {
  const modal = page.locator('div.fixed.inset-0.z-50').first()
  await modal.waitFor({ state: 'hidden', timeout: timeoutMs }).catch(() => {})
  await page.waitForTimeout(600)
}

async function run() {
  const browser = await chromium.launch({
    headless: false,
    slowMo: 300,
    executablePath: CHROMIUM,
  })
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()

  page.on('console', m => { if (m.type() === 'error') log(`[browser] ${m.text().substring(0, 100)}`) })
  page.on('response', r => {
    if (r.url().includes('/api/') && r.status() >= 400) log(`[${r.status()}] ${r.url()}`)
  })

  // ── STEP 1: Login ────────────────────────────────────────────────────────
  log('=== STEP 1: Login ===')
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#email', { timeout: 15000 })
  await page.fill('#email', EMAIL)
  await page.fill('#password', PASSWORD)
  await page.click('button[type="submit"]')

  let landed = false
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.waitForFunction(() => !window.location.pathname.startsWith('/login'), { timeout: 15000 })
      await page.waitForTimeout(1500)
      if (!page.url().includes('/login')) { landed = true; break }
      log(`Bounced back to /login on attempt ${attempt + 1}, retrying...`)
    } catch {
      log(`Login timeout on attempt ${attempt + 1}, retrying...`)
    }
    await page.waitForSelector('#email', { timeout: 8000 }).catch(() => {})
    await page.fill('#email', EMAIL)
    await page.fill('#password', PASSWORD)
    await page.click('button[type="submit"]')
  }

  if (!landed) {
    log('Force navigating to /restaurant...')
    await page.goto(`${BASE}/restaurant`, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.waitForTimeout(2000)
    if (page.url().includes('/login')) {
      bug('Login failed — still on /login after force navigate')
      await ss(page, '01-login-failed')
      await browser.close(); return
    }
    landed = true
  }

  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
  log(`Landed: ${page.url()}`)
  await ss(page, '01-dashboard')

  // Confirm restaurant shell loaded
  const asideEl = await page.waitForSelector('aside', { timeout: 10000 }).catch(() => null)
  if (!asideEl) { bug('No sidebar — restaurant shell not loaded'); await ss(page, '01b-no-sidebar'); await browser.close(); return }
  log('Sidebar confirmed')

  // ── STEP 2: Settings — enable Dish Tracking via API ─────────────────────
  log('=== STEP 2: Enable Dish Tracking ===')

  // Check current tracking mode via user profile API
  const profileData = await page.evaluate(async () => {
    const r = await fetch('/api/user/profile', { credentials: 'include' })
    return r.ok ? r.json() : null
  }).catch(() => null)

  const currentMode = profileData?.trackingMode ?? 'simple'
  log(`Current tracking mode: ${currentMode}`)

  if (currentMode !== 'dish_tracking') {
    log('Enabling dish_tracking via API...')
    const patchResult = await page.evaluate(async () => {
      const r = await fetch('/api/user/profile', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackingMode: 'dish_tracking' }),
      })
      return { ok: r.ok, status: r.status, data: await r.json().catch(() => null) }
    }).catch(err => ({ ok: false, error: err.message }))

    if (patchResult.ok) {
      log('Dish tracking enabled via API')
      // Reload so the sidebar shows Menu/Tables/Orders
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
      await page.waitForTimeout(2000)
    } else {
      bug(`Failed to enable dish tracking: ${JSON.stringify(patchResult)}`)
    }
  } else {
    log('Dish tracking already active')
  }
  await ss(page, '02-dish-tracking')

  // ── STEP 3: Menu — add 3 dishes ─────────────────────────────────────────
  log('=== STEP 3: Menu ===')
  await sidebar(page, 'Menu')
  // Wait for menu to load
  await page.waitForSelector('button:has-text("Add Menu Item"), button:has-text("Add Dish")', { timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(1000)
  await ss(page, '03-menu')

  const addDishBtn = page.locator('button').filter({ hasText: /Add Menu Item|Add Dish|New Dish/i }).first()

  async function addDish(name, price, category) {
    if (!await addDishBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      bug(`Add dish button not visible before adding ${name}`)
      return false
    }
    await addDishBtn.click()
    await page.waitForTimeout(600)

    // Wait for form modal to appear
    await page.waitForSelector('div.fixed.inset-0', { timeout: 5000 }).catch(() => {})

    await page.getByPlaceholder('e.g. Grilled Tilapia').fill(name)
    await page.getByPlaceholder('5000').fill(String(price))

    const catInput = page.locator('input[placeholder*="category" i]').first()
    if (await catInput.isVisible({ timeout: 1500 }).catch(() => false)) await catInput.fill(category)

    // Click the submit button inside the modal form
    const submitBtn = page.locator('div.fixed.inset-0 button[type="submit"]').first()
    if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await submitBtn.click()
    } else {
      // Fallback: any Create/Save button
      await page.locator('button').filter({ hasText: /Create Menu Item|Save Changes/ }).first().click()
    }

    // Wait for modal to disappear (form submitted successfully)
    const modalGone = await page.locator('div.fixed.inset-0.z-50').first()
      .waitFor({ state: 'hidden', timeout: 12000 })
      .then(() => true)
      .catch(() => false)

    if (!modalGone) {
      bug(`Modal did not close after saving dish "${name}" — POST may have failed`)
      // Force close the modal by pressing Escape
      await page.keyboard.press('Escape')
      await page.waitForTimeout(500)
    } else {
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
      log(`Added dish: ${name} @ ${price}`)
    }
    return modalGone
  }

  await addDish('Grilled Chicken', 4500, 'Mains')
  await ss(page, '03b-dish1-added')
  await addDish('French Fries', 2000, 'Sides')
  await ss(page, '03c-dish2-added')
  await addDish('Soda', 1000, 'Drinks')
  await ss(page, '03d-dish3-added')

  // ── STEP 4: Tables — add Table 1 ────────────────────────────────────────
  log('=== STEP 4: Tables ===')
  await sidebar(page, 'Tables')
  await page.waitForTimeout(1500)
  await ss(page, '04-tables')

  // "Add Table" button in the header
  const addTableBtn = page.locator('button').filter({ hasText: 'Add Table' }).first()
  if (await addTableBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await addTableBtn.click()
    await page.waitForTimeout(600)

    // Fill form
    const tableNameInput = page.locator('input[placeholder*="table" i], input[placeholder*="name" i], input[placeholder*="Table" i]').first()
    if (await tableNameInput.isVisible({ timeout: 3000 }).catch(() => false)) {
      await tableNameInput.fill('Table 1')
    }

    // Click "Add Table" confirm button
    const confirmTableBtn = page.locator('button').filter({ hasText: /^Add Table$/ }).last()
    if (await confirmTableBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await confirmTableBtn.click()
    } else {
      await page.locator('button[type="button"]').filter({ hasText: /Save|Confirm|Create/ }).last().click()
    }

    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(1500)
    log('Added: Table 1')
    await ss(page, '04b-table-added')
  } else {
    bug('Add Table button not found')
    await ss(page, '04b-no-table-btn')
  }

  // ── STEP 5: Orders — place an order ──────────────────────────────────────
  log('=== STEP 5: Orders ===')
  await sidebar(page, 'Orders')
  // Wait for the orders page to load tables
  await page.waitForTimeout(2000)
  await ss(page, '05-orders')

  // Click on Table 1 in the table selection row
  const table1Btn = page.locator('button').filter({ hasText: 'Table 1' }).first()
  if (await table1Btn.isVisible({ timeout: 6000 }).catch(() => false)) {
    await table1Btn.click()
    await page.waitForTimeout(1000)
    log('Selected Table 1')
    await ss(page, '05b-table-selected')
  } else {
    bug('Table 1 button not found on Orders page')
    await ss(page, '05b-no-table')
  }

  // Dishes appear in the grid — click Grilled Chicken
  const chickenBtn = page.locator('button').filter({ hasText: 'Grilled Chicken' }).first()
  if (await chickenBtn.isVisible({ timeout: 6000 }).catch(() => false)) {
    await chickenBtn.click()
    await page.waitForTimeout(500)
    log('Added Grilled Chicken to order')
  } else {
    bug('Grilled Chicken dish not found on order page')
  }

  // Click French Fries
  const friesBtn = page.locator('button').filter({ hasText: 'French Fries' }).first()
  if (await friesBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await friesBtn.click()
    await page.waitForTimeout(500)
    log('Added French Fries to order')
  }

  await ss(page, '05c-order-items')

  // Confirm the order
  const confirmOrderBtn = page.locator('button').filter({ hasText: /Confirm order|Place Order|Submit/i }).first()
  if (await confirmOrderBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await confirmOrderBtn.click()
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
    await page.waitForTimeout(2000)
    log('Order confirmed!')
    await ss(page, '05d-order-placed')
  } else {
    bug('Confirm order button not found')
    await ss(page, '05c-no-confirm-btn')
  }

  // ── STEP 6: Pay the order ─────────────────────────────────────────────────
  log('=== STEP 6: Payment ===')
  await page.waitForTimeout(1000)

  // Find the Pay button for this table
  const payBtn = page.locator('button').filter({ hasText: /^Pay$/ }).first()
  if (await payBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
    await payBtn.click()
    await page.waitForTimeout(800)
    await ss(page, '06b-pay-modal')

    // Select cash payment method if shown
    const cashBtn = page.locator('button').filter({ hasText: /Cash/ }).first()
    if (await cashBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await cashBtn.click()
      await page.waitForTimeout(400)
    }

    // Confirm payment
    const confirmPayBtn = page.locator('button').filter({ hasText: /Confirm.*[Pp]ay|Complete|Done|Collect/i }).first()
    if (await confirmPayBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await confirmPayBtn.click()
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
      await page.waitForTimeout(2000)
      log('Payment collected!')
      await ss(page, '06c-paid')
    } else {
      // Sometimes the modal closes automatically after cash selection
      await page.waitForTimeout(2000)
      log('Payment modal may have auto-closed')
      await ss(page, '06c-after-pay')
    }
  } else {
    log('No Pay button visible — order may need kitchen to mark ready first')
    await ss(page, '06-no-pay-btn')
  }

  // ── STEP 7: Live View ─────────────────────────────────────────────────────
  log('=== STEP 7: Live View ===')
  await sidebar(page, 'Live View')
  await page.waitForTimeout(3000)
  await ss(page, '07-live-view')

  // ── STEP 8: Reports ──────────────────────────────────────────────────────
  log('=== STEP 8: Reports ===')
  await sidebar(page, 'Reports')
  await page.waitForTimeout(3000)
  await ss(page, '08-reports')

  // ── STEP 9: Transactions ─────────────────────────────────────────────────
  log('=== STEP 9: Transactions ===')
  await sidebar(page, 'Transactions')
  await page.waitForTimeout(2000)
  await ss(page, '09-transactions')

  // ── Summary ───────────────────────────────────────────────────────────────
  log(`\n=== BUG REPORT (${bugs.length} bugs) ===`)
  bugs.forEach((b, i) => log(`  ${i + 1}. ${b}`))
  if (bugs.length === 0) log('  No bugs detected!')
  log('\nKeeping browser open for 10 min — press Ctrl+C to exit earlier.')
  await page.waitForTimeout(10 * 60 * 1000).catch(() => {})
  await browser.close()
}

run().catch(err => { console.error('FATAL:', err.message); process.exit(1) })
