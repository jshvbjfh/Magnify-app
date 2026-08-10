import { chromium } from 'playwright'

const OUT = 'C:\\Users\\HP\\AppData\\Local\\Temp\\claude\\c--Users-HP-Documents-restaurant-app\\e1c5eb4e-efe6-403c-bb8c-8d54d06f9dff\\scratchpad'
const BASE = 'http://localhost:3001'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })

const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message))

async function shot(name) {
  await page.screenshot({ path: `${OUT}\\${name}.png`, fullPage: false })
  console.log('shot:', name, '| url:', page.url())
}

console.log('1. login page')
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 120000 })
await page.waitForSelector('#email', { timeout: 60000 })
// The inputs are React-controlled; typing before hydration completes gets wiped
// when the client takes over. Settle first, then type, then prove it stuck.
await page.waitForLoadState('networkidle', { timeout: 120000 }).catch(() => {})
await page.waitForTimeout(2500)

for (let attempt = 1; attempt <= 3; attempt++) {
  await page.click('#email')
  await page.fill('#email', '')
  await page.type('#email', 'high5ive@management.com', { delay: 15 })
  await page.click('#password')
  await page.fill('#password', '')
  await page.type('#password', '50000000', { delay: 15 })
  const email = await page.inputValue('#email')
  const pass = await page.inputValue('#password')
  console.log(`   attempt ${attempt}: email="${email}" password=${pass.length} chars`)
  if (email === 'high5ive@management.com' && pass.length === 8) break
  await page.waitForTimeout(1500)
}
await shot('01-login')

console.log('2. submitting')
await Promise.all([
  page.waitForURL('**/restaurant**', { timeout: 180000 }).catch(() => {}),
  page.click('button[type="submit"]'),
])
await page.waitForLoadState('networkidle', { timeout: 180000 }).catch(() => {})
await shot('02-after-login')

// Find the Reports navigation entry
console.log('3. opening Reports')
const reportsNav = page.getByText('Reports', { exact: true }).first()
if (await reportsNav.count() > 0) {
  await reportsNav.click({ timeout: 30000 }).catch((e) => console.log('reports click failed:', e.message))
} else {
  console.log('!! no element with exact text "Reports" found')
}
await page.waitForTimeout(4000)
await shot('03-reports')

// Find the Upsell tab chip
console.log('4. opening Upsell tab')
const upsell = page.getByRole('button', { name: /upsell/i }).first()
const count = await upsell.count()
console.log('upsell chip count:', count)
if (count > 0) {
  await upsell.click({ timeout: 30000 }).catch((e) => console.log('upsell click failed:', e.message))
} else {
  const anyUpsell = page.getByText(/upsell/i).first()
  console.log('fallback text match count:', await anyUpsell.count())
  if (await anyUpsell.count() > 0) await anyUpsell.click({ timeout: 30000 }).catch(() => {})
}

await page.waitForTimeout(8000)
await shot('04-upsell')
await page.screenshot({ path: `${OUT}\\05-upsell-full.png`, fullPage: true })
console.log('shot: 05-upsell-full')

const bodyText = await page.locator('body').innerText()
const probe = ['Upsell Gross Profit', 'Profit per Bill', 'Profit Opportunity', "Jesse's take",
               'Top opportunities', 'What sells together', 'Who sells it', 'About this report',
               'Mimi', 'Kenny', 'Confidence']
console.log('\n--- content probe ---')
for (const p of probe) console.log(`  ${bodyText.includes(p) ? 'FOUND   ' : 'MISSING '} ${p}`)

console.log('\n--- console errors ---')
console.log(errors.length ? errors.slice(0, 12).join('\n') : '  none')

await browser.close()
