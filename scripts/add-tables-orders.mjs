/**
 * Adds 5 tables and places a test order.
 * All 25 dishes already exist — this is the final step.
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'fs'

const SS_DIR = 'scripts/screenshots/tables'
mkdirSync(SS_DIR, { recursive: true })

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
  return path
}

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
  log('Logged in ✓')
  return jar
}

async function run() {
  const cookieJar = await httpLogin()
  const browser = await chromium.launch({ headless: false, slowMo: 200, executablePath: CHROMIUM })
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await ctx.addCookies(Object.entries(cookieJar).map(([name, value]) => ({
    name, value, domain: 'localhost', path: '/', httpOnly: false, secure: false, sameSite: 'Lax',
  })))
  const page = await ctx.newPage()
  page.on('response', r => { if (r.url().includes('/api/') && r.status() >= 400) log(`[${r.status()}] ${r.url()}`) })

  await page.goto(`${BASE}/restaurant`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(3000)

  // ── TABLES ─────────────────────────────────────────────────────────────────
  log('\n=== Tables ===')
  const tablesBtn = page.locator('aside nav button').filter({ hasText: /^Tables$/ }).first()
  await tablesBtn.waitFor({ state: 'visible', timeout: 15000 })
  await tablesBtn.click()
  await page.waitForTimeout(2500)
  await shot(page, 'tables-start')

  for (let i = 1; i <= 5; i++) {
    log(`\nAdding Table ${i}...`)

    // Click the "+ Add Table" button in the page header
    const addBtn = page.locator('button').filter({ hasText: /Add Table/ }).first()
    await addBtn.waitFor({ state: 'visible', timeout: 6000 })
    await addBtn.click()
    await page.waitForTimeout(800)

    // From the screenshot: fill TABLE NAME / NUMBER field
    // Placeholder: "e.g. T1, Terrace 1, VIP"
    const nameInput = page.getByPlaceholder('e.g. T1, Terrace 1, VIP')
    await nameInput.waitFor({ state: 'visible', timeout: 5000 })
    await nameInput.fill(`Table ${i}`)
    await page.waitForTimeout(300)

    await shot(page, `table-${i}-filled`)

    // Click "Add Table" button INSIDE the modal (the orange one that's now enabled)
    // Scope to the modal overlay to avoid hitting the page-level button
    const modalAddBtn = page.locator('div.fixed.inset-0.z-50 button').filter({ hasText: 'Add Table' }).first()
    await modalAddBtn.waitFor({ state: 'visible', timeout: 3000 })
    const isEnabled = await modalAddBtn.isEnabled()
    log(`Modal "Add Table" button enabled: ${isEnabled}`)

    if (isEnabled) {
      await modalAddBtn.click()
    } else {
      // Fallback: press Enter in the name field
      await nameInput.press('Enter')
    }

    // Wait for modal to close
    await page.locator('div.fixed.inset-0.z-50').first()
      .waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(1000)

    await shot(page, `table-${i}-done`)
    log(`Table ${i} added`)
  }

  await shot(page, 'tables-complete')
  const bodyText = await page.innerText('body').catch(() => '')
  log(`Tables page after adding: ${bodyText.slice(0, 400)}`)

  // ── ORDERS ─────────────────────────────────────────────────────────────────
  log('\n=== Orders ===')
  const ordersBtn = page.locator('aside nav button').filter({ hasText: /^Orders$/ }).first()
  await ordersBtn.waitFor({ state: 'visible', timeout: 10000 })
  await ordersBtn.click()
  await page.waitForTimeout(2500)
  await shot(page, 'orders-start')

  // Read orders page to understand layout
  const ordText = await page.innerText('body').catch(() => '')
  log(`Orders page: ${ordText.slice(0, 600)}`)

  // Click Table 1
  const table1Btn = page.locator('button').filter({ hasText: /^Table 1$/ }).first()
  if (await table1Btn.isVisible({ timeout: 6000 }).catch(() => false)) {
    await table1Btn.click()
    await page.waitForTimeout(1500)
    await shot(page, 'table1-selected')
    log('Table 1 selected')

    // Read current state
    const panelText = await page.innerText('body').catch(() => '')
    log(`After table select: ${panelText.slice(0, 600)}`)

    // Add Margherita Pizza
    const margherita = page.locator('button').filter({ hasText: /Margherita/i }).first()
    if (await margherita.isVisible({ timeout: 5000 }).catch(() => false)) {
      await margherita.click()
      await page.waitForTimeout(400)
      log('Added: Margherita Pizza')
    } else {
      log('Margherita not visible — checking all dish buttons...')
      const allBtns = await page.locator('button').allInnerTexts()
      log(`All buttons: ${allBtns.filter(t => t.trim().length > 0).slice(0, 20).join(' | ')}`)
    }

    // Add Grilled Chicken
    const chicken = page.locator('button').filter({ hasText: /Grilled Chicken/i }).first()
    if (await chicken.isVisible({ timeout: 3000 }).catch(() => false)) {
      await chicken.click()
      await page.waitForTimeout(400)
      log('Added: Grilled Chicken')
    }

    await shot(page, 'order-items')

    // Find and click the confirm order button
    const allBtnTexts = await page.locator('button').allInnerTexts()
    log(`Buttons: ${allBtnTexts.filter(t => t.trim()).join(' | ')}`)

    const confirmBtn = page.locator('button').filter({ hasText: /Confirm order|Place Order|Submit/i }).first()
    if (await confirmBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await confirmBtn.click()
      await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {})
      await page.waitForTimeout(2000)
      await shot(page, 'order-confirmed')
      log('✓ Order placed successfully!')
    } else {
      log('Confirm button not found')
      await shot(page, 'no-confirm-btn')
    }
  } else {
    log('Table 1 not found')
    await shot(page, 'no-table1')
    // Show what's there
    const allBtns = await page.locator('button').allInnerTexts()
    log(`All buttons: ${allBtns.filter(t=>t.trim()).join(' | ')}`)
  }

  log('\n=== Complete! Browser stays open — close with Ctrl+C ===')
  await page.waitForTimeout(10 * 60 * 1000).catch(() => {})
  await browser.close()
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
