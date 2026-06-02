/**
 * Playwright: upload QR menu hero image by physically clicking through the browser UI.
 *
 * Flow:
 *  1. Sign in → Settings → click "Dish Tracking" card button
 *  2. Wait for sidebar Menu item to appear → click it
 *  3. Click "QR Menu" tab → set file → wait for upload → verify
 */
import { chromium } from 'playwright'
import { existsSync, mkdirSync } from 'fs'
import { resolve } from 'path'

const BASE = 'https://magnify-app-tau.vercel.app'
const EMAIL = 'highfive@magnify.test'
const PASSWORD = 'hello@123'
const IMAGE_PATH = resolve('C:\\Users\\HP\\Pictures\\Screenshots\\Screenshot 2026-05-23 095407.png')
const SS_DIR = 'scripts/screenshots/qr-upload'
mkdirSync(SS_DIR, { recursive: true })

const log = msg => console.log(`[${new Date().toISOString()}] ${msg}`)
let n = 0
const shot = async (page, label) => {
  const name = `${String(++n).padStart(2, '0')}-${label}.png`
  await page.screenshot({ path: `${SS_DIR}/${name}`, fullPage: false })
  log(`Screenshot: ${name}`)
}

async function main() {
  if (!existsSync(IMAGE_PATH)) { log(`ERROR: Image not found: ${IMAGE_PATH}`); process.exit(1) }
  log(`Image confirmed: ${IMAGE_PATH}`)

  const browser = await chromium.launch({ headless: false, slowMo: 350 })
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await ctx.newPage()

  // ── 1. Open portal ────────────────────────────────────────────────────────
  log('Opening manager portal...')
  await page.goto(`${BASE}/restaurant`, { waitUntil: 'networkidle' })
  await shot(page, 'landing')

  // ── 2. Sign in if needed ──────────────────────────────────────────────────
  if (page.url().includes('/auth') || page.url().includes('/signin') || page.url().includes('/login')) {
    log('Signing in...')
    await page.fill('input[type="email"], input[name="email"]', EMAIL)
    await page.fill('input[type="password"], input[name="password"]', PASSWORD)
    await shot(page, 'credentials')
    await page.click('button[type="submit"]')
    await page.waitForURL(`${BASE}/restaurant**`, { timeout: 30000 }).catch(() => {})
    await page.waitForTimeout(2000)
    await shot(page, 'after-login')
    log(`URL: ${page.url()}`)
  }

  // ── 3. Click Settings in sidebar ──────────────────────────────────────────
  log('Clicking Settings in sidebar...')
  // Sidebar buttons are inside <aside><nav> - find the one whose span text is "Settings"
  const settingsBtn = page.locator('aside nav button', { hasText: 'Settings' }).first()
  await settingsBtn.waitFor({ timeout: 10000 })
  await settingsBtn.click()
  await page.waitForTimeout(2000)
  await shot(page, 'settings-page')

  // ── 4. Scroll down to the Dish Tracking card and click it ─────────────────
  log('Scrolling to Dish Tracking section...')
  // The Dish Tracking button is in the right column. Use text "Full Kitchen Control" as anchor
  const dishTrackingBtn = page.locator('button', { hasText: 'Full Kitchen Control' }).first()
  await dishTrackingBtn.scrollIntoViewIfNeeded()
  await page.waitForTimeout(500)
  await shot(page, 'dish-tracking-visible')
  log('Clicking Dish Tracking button...')
  await dishTrackingBtn.click()
  // Wait for save indicator (button should show "Saved!" or sidebar should change)
  await page.waitForTimeout(4000)
  await shot(page, 'dish-tracking-saved')

  // ── 5. Wait for Menu to appear in sidebar and click it ────────────────────
  log('Waiting for Menu item in sidebar...')
  const menuSidebarBtn = page.locator('aside nav button', { hasText: 'Menu' }).first()
  await menuSidebarBtn.waitFor({ timeout: 20000 })
  log('Menu in sidebar found, clicking...')
  await menuSidebarBtn.click()
  await page.waitForTimeout(3000)
  await shot(page, 'menu-tab-open')

  // ── 6. Click the QR Menu tab inside the Menu page ────────────────────────
  log('Clicking QR Menu tab...')
  // This tab button is in the main content area (not sidebar)
  const qrMenuTab = page.locator('main button, [role="main"] button, .flex button').filter({ hasText: 'QR Menu' }).first()
  await qrMenuTab.waitFor({ timeout: 15000 })
  await qrMenuTab.click()
  await page.waitForTimeout(3000)
  await shot(page, 'qr-menu-studio')

  // ── 7. Wait for QR studio to load (Upload image button enabled) ───────────
  log('Waiting for QR studio to load...')
  await page.waitForFunction(() => {
    const btns = [...document.querySelectorAll('button')]
    return btns.some(b => (b.textContent?.includes('Upload image') || b.textContent?.includes('Replace image')) && !b.disabled)
  }, { timeout: 30000 }).catch(() => log('Warning: button enabled check timed out'))
  await shot(page, 'studio-ready')

  // ── 8. Set file on the hidden <input type="file"> ─────────────────────────
  log('Attaching image file...')
  const fileInput = page.locator('input[type="file"]').first()
  await fileInput.waitFor({ state: 'attached', timeout: 10000 })
  await fileInput.setInputFiles(IMAGE_PATH)
  log('File attached — waiting for upload to finish...')

  // ── 9. Wait for upload to complete ────────────────────────────────────────
  // The button text changes from "Uploading image..." back to "Replace image"
  await page.waitForFunction(() => {
    const btns = [...document.querySelectorAll('button')]
    return !btns.some(b => b.textContent?.includes('Uploading image'))
  }, { timeout: 60000 }).catch(() => log('Upload wait timed out'))
  await page.waitForTimeout(2000)
  await shot(page, 'after-upload')

  const successEl = await page.$('.text-green-700, [class*="green"]')
  if (successEl) log(`Success: ${await successEl.textContent()}`)

  const errorEl = await page.$('.text-red-700, [class*="red"]')
  if (errorEl) log(`Error on page: ${await errorEl.textContent()}`)

  // ── 10. Verify on the public QR order page ────────────────────────────────
  log('Opening public order page to verify image...')
  await page.goto(
    'https://magnify-app-tau.vercel.app/order/cmpelduka0002obyu77inyybz/cmpi5rmqv0005m0kfwfm2b5cr',
    { waitUntil: 'networkidle', timeout: 30000 }
  )
  await page.waitForTimeout(3000)
  await shot(page, 'order-page-verify')
  log('Done! Screenshots saved to scripts/screenshots/qr-upload/')

  await page.waitForTimeout(5000)
  await browser.close()
}

main().catch(err => { console.error('Failed:', err.message); process.exit(1) })
