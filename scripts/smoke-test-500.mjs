import { chromium } from 'playwright'

const errors = []
const b = await chromium.launch({
  headless: true,
  executablePath: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
})
const ctx = await b.newContext()
const page = await ctx.newPage()
page.on('response', r => {
  if (r.url().includes('/api/') && r.status() >= 500) errors.push(`${r.status()} ${r.url()}`)
})

await page.goto('http://localhost:3001/login')
await page.fill('#email', 'testmanager@magnify.test')
await page.fill('#password', 'Test1234!')
await page.click('button[type="submit"]')
await page.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 20000 })
await page.waitForLoadState('networkidle')

// Live View — hits /api/restaurant/dish-sales
const lv = page.locator('aside button:has-text("Live View"), aside a:has-text("Live View")').first()
await lv.waitFor({ timeout: 8000 })
await lv.click()
await page.waitForTimeout(3000)

// Reports — hits /api/restaurant/reports/theoretical-inventory + inventory-movement
const rp = page.locator('aside button:has-text("Reports"), aside a:has-text("Reports")').first()
await rp.waitFor({ timeout: 8000 })
await rp.click()
await page.waitForTimeout(4000)

// Settings — hits /api/restaurant/fifo-validation
const st = page.locator('aside button:has-text("Settings"), aside a:has-text("Settings")').first()
await st.waitFor({ timeout: 8000 })
await st.click()
await page.waitForTimeout(3000)

console.log(`\n=== 500 ERRORS: ${errors.length} ===`)
errors.forEach(e => console.log(' ', e))
if (errors.length === 0) console.log('  None — all clear!')

await b.close()
