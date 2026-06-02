/**
 * End-to-end QR order test:
 *  Guest window (mobile): browse QR menu → add dish → place order
 *  Manager window:         watch Orders page before and after
 *  Pull API check:         simulate what waiter app sees on next sync
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'fs'

const BASE = 'https://magnify-app-tau.vercel.app'
const QR_URL = `${BASE}/order/cmpkzkst10002sezqbhil6cwh/cmpl2vup60006ctv3iioj70i5`
const MANAGER_EMAIL = 'highfive@magnify.test'
const MANAGER_PASS = 'hello@123'
const SS_DIR = 'scripts/screenshots/qr-order-test'
mkdirSync(SS_DIR, { recursive: true })

const log = msg => console.log(`[${new Date().toISOString()}] ${msg}`)
let n = 0
const shot = async (page, label) => {
  const name = `${String(++n).padStart(2, '0')}-${label}.png`
  await page.screenshot({ path: `${SS_DIR}/${name}`, fullPage: false })
  log(`📸 ${name}`)
}

async function signIn(page) {
  await page.waitForTimeout(1500)
  if (!page.url().includes('/auth') && !page.url().includes('/signin') && !page.url().includes('/login')) return
  log('Signing in...')
  await page.fill('input[type="email"]', MANAGER_EMAIL)
  await page.fill('input[type="password"]', MANAGER_PASS)
  await page.click('button[type="submit"]')
  await page.waitForURL(`${BASE}/restaurant**`, { timeout: 30000 }).catch(() => {})
  await page.waitForTimeout(2000)
}

async function main() {
  const browser = await chromium.launch({ headless: false, slowMo: 300 })

  // ── Manager window: sign in and open Orders page ───────────────────────────
  log('=== Manager portal ===')
  const mCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const mPage = await mCtx.newPage()
  await mPage.goto(`${BASE}/restaurant`, { waitUntil: 'networkidle' })
  await signIn(mPage)
  await shot(mPage, 'manager-home')

  // Click Orders in sidebar
  const ordersSpan = mPage.locator('aside nav button span').filter({ hasText: /^Orders$/ }).first()
  await ordersSpan.waitFor({ timeout: 12000 })
  await ordersSpan.click()
  await mPage.waitForTimeout(2000)
  await shot(mPage, 'manager-orders-before-order')
  log('Manager is on Orders page (baseline)')

  // ── Guest window: QR menu ──────────────────────────────────────────────────
  log('\n=== Guest QR menu ===')
  const gCtx = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const gPage = await gCtx.newPage()
  await gPage.goto(QR_URL, { waitUntil: 'networkidle' })
  await gPage.waitForTimeout(2000)
  await shot(gPage, 'qr-menu-loaded')

  // Scroll down past the hero + category filters to reach dish cards
  log('Scrolling to dish cards...')
  await gPage.evaluate(() => window.scrollBy(0, 500))
  await gPage.waitForTimeout(1000)
  await shot(gPage, 'scrolled-to-dishes')

  // Each dish is in an <article>. The + add button is inside the article.
  // It's the last button in the article (either h-10 w-10 for no-variant or h-9 w-9 for variant).
  log('Clicking the + add button on first dish...')

  // Scroll into view of first article's add button
  const firstArticle = gPage.locator('article').first()
  await firstArticle.scrollIntoViewIfNeeded()
  await gPage.waitForTimeout(500)
  await shot(gPage, 'first-article-visible')

  // The add button is the last button inside the article
  const addDishBtn = firstArticle.locator('button').last()
  await addDishBtn.waitFor({ timeout: 8000 })
  log(`Add button text: "${await addDishBtn.textContent()}"`)
  await addDishBtn.click()
  log('Clicked add button on first dish')

  await gPage.waitForTimeout(1500)
  await shot(gPage, 'after-add-dish')

  // ── Check if "View Cart" sticky button appeared ────────────────────────────
  log('Waiting for View Cart button...')
  const viewCartBtn = gPage.locator('button').filter({ hasText: /view cart/i }).first()
  await viewCartBtn.waitFor({ timeout: 10000 })
  await shot(gPage, 'view-cart-visible')
  log('Clicking View Cart...')
  await viewCartBtn.click()
  await gPage.waitForTimeout(2000)
  await shot(gPage, 'cart-modal-open')

  // ── Click Place Order ──────────────────────────────────────────────────────
  log('Clicking Place Order...')
  const placeOrderBtn = gPage.locator('button').filter({ hasText: /place order/i }).first()
  await placeOrderBtn.waitFor({ timeout: 8000 })
  await shot(gPage, 'before-place-order')
  await placeOrderBtn.click()
  await gPage.waitForTimeout(4000)
  await shot(gPage, 'order-submitted')
  log('Order submitted!')

  // Check success state
  const successMsg = await gPage.locator('text=Order Placed').isVisible().catch(() => false)
  log(successMsg ? '✅ Success screen shown: "Order Placed!"' : '⚠️  Success screen not confirmed')

  // ── Manager: refresh and check Orders ─────────────────────────────────────
  log('\n=== Checking manager portal for order ===')
  await mPage.reload({ waitUntil: 'networkidle' })
  await mPage.waitForTimeout(3000)
  await shot(mPage, 'manager-orders-after-order')

  // Also check Live View
  const liveSpan = mPage.locator('aside nav button span').filter({ hasText: /^Live View$/ }).first()
  if (await liveSpan.isVisible({ timeout: 3000 }).catch(() => false)) {
    await liveSpan.click()
    await mPage.waitForTimeout(3000)
    await shot(mPage, 'manager-live-view')
  }

  // ── Pull API: simulate waiter app sync ────────────────────────────────────
  log('Calling pull API (simulating waiter app sync)...')
  const pullResult = await mPage.evaluate(async (base) => {
    const res = await fetch(`${base}/api/mobile/pull?restaurantId=cmpkzkst10002sezqbhil6cwh`, {
      credentials: 'include'
    })
    if (!res.ok) return { error: `HTTP ${res.status}` }
    const d = await res.json()
    return {
      incomingOrders: d.incomingOrders?.length ?? 0,
      recentOrders: d.recentOrders?.length ?? 0,
      sample: d.incomingOrders?.[0]
        ? {
            status: d.incomingOrders[0].status,
            items: d.incomingOrders[0].items?.length,
            table: d.incomingOrders[0].table_name,
          }
        : null
    }
  }, BASE)

  log(`Pull API: ${JSON.stringify(pullResult)}`)
  if (pullResult.incomingOrders > 0) {
    log(`✅ Waiter app WOULD see ${pullResult.incomingOrders} incoming order(s) on next sync!`)
    log(`   First order: table "${pullResult.sample?.table}", ${pullResult.sample?.items} item(s), status: ${pullResult.sample?.status}`)
  } else {
    log('⚠️  No incoming orders visible via pull API yet')
  }

  await shot(mPage, 'final-state')
  log('\nAll done! Screenshots in scripts/screenshots/qr-order-test/')
  await mPage.waitForTimeout(6000)
  await browser.close()
}

main().catch(err => { console.error('Failed:', err.message); process.exit(1) })
