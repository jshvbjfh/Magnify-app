import { chromium } from 'playwright'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const BASE  = 'https://magnify-app-tau.vercel.app'
const EMAIL = 'highfive@magnify.test'
const PASS  = 'hello@123'
const OUT   = join(tmpdir(), 'pw-highfive')
mkdirSync(OUT, { recursive: true })
console.log('Screenshots →', OUT)

let n = 0
async function shot(page, label) {
  const f = join(OUT, `${String(++n).padStart(2,'0')}-${label}.png`)
  await page.screenshot({ path: f, fullPage: false })
  console.log(`  📸 ${label}`)
}

async function waitLoaded(page) {
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForFunction(
    () => document.querySelectorAll('.animate-pulse').length === 0,
    { timeout: 10000 }
  ).catch(() => {})
  await page.waitForTimeout(400)
}

const browser = await chromium.launch({ headless: true, slowMo: 400 })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()

// ── Login ─────────────────────────────────────────────────────────────────────
console.log('\n── LOGIN ───────────────────────────────────────────')
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await shot(page, '01-login')
await page.fill('input[type="email"]', EMAIL)
await page.fill('input[type="password"]', PASS)
await page.click('button[type="submit"]')
await page.waitForURL(/\/restaurant/, { timeout: 20000 })
await waitLoaded(page)
await shot(page, '02-transactions-main')
console.log('Logged in ✓')

// Wait for branch cards to enable
await page.waitForFunction(() => {
  const barBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Bar & Drinks'))
  return barBtn && !barBtn.disabled
}, { timeout: 20000 }).catch(() => console.log('  (branch cards slow)'))

const branches = [
  { name: 'Main',            desc: 'Takeaway lunch service revenue',  amount: '14500', pay: 'Cash'         },
  { name: 'Bar & Drinks',    desc: 'Cocktail evening sales',          amount: '28000', pay: 'Mobile Money' },
  { name: 'Burger Station',  desc: 'Smash burger combo sales',        amount: '19500', pay: 'Cash'         },
  { name: 'Grill & BBQ',     desc: 'BBQ platter weekend revenue',     amount: '32000', pay: 'Mobile Money' },
  { name: 'Pizza Station',   desc: 'Family pizza box revenue',        amount: '16800', pay: 'Cash'         },
  { name: 'Spirits & Shots', desc: 'Premium spirits bar revenue',     amount: '41000', pay: 'Mobile Money' },
]

for (let i = 0; i < branches.length; i++) {
  const b = branches[i]
  const slug = `${i+1}-${b.name.replace(/[^a-z0-9]/gi,'-').toLowerCase()}`
  console.log(`\n── ${i+1}/6  ${b.name} ───`)

  // Switch branch (skip if already active = disabled)
  const card = page.locator('button').filter({ hasText: b.name }).first()
  const isDisabled = await card.evaluate(el => el.disabled).catch(() => false)
  if (!isDisabled) {
    console.log('  Switching branch...')
    await card.click()
    await waitLoaded(page)
    console.log(`  On "${b.name}" ✓`)
  } else {
    console.log(`  Already on "${b.name}" ✓`)
  }
  await shot(page, `${slug}-01-branch`)

  // Open Add Transaction (inline form)
  console.log('  Opening form...')
  const addBtn = page.locator('button').filter({ hasText: /add transaction/i }).first()
  await addBtn.waitFor({ state: 'visible', timeout: 10000 })
  await addBtn.click()
  await page.waitForTimeout(600)

  // Form fields (confirmed by DOM inspection):
  // [0] Search input — SKIP
  // [1] SELECT — Type (income/expense)
  // [2] SELECT — Category (Other Income / Other Expense)
  // [3] INPUT text — Description, placeholder="e.g. Paid rent for May"
  // [4] INPUT text — Amount, placeholder="0"
  // [5] SELECT — Payment (Cash / Mobile Money / ...)
  // [6] INPUT date — Date

  // Step 1: Set Type to Income
  const typeSelect = page.locator('select').nth(0)
  await typeSelect.waitFor({ state: 'visible', timeout: 5000 })
  await typeSelect.selectOption({ label: 'Income' })
  await page.waitForTimeout(400)

  // Step 2: Description — placeholder="e.g. Paid rent for May"
  console.log(`  Description: "${b.desc}"`)
  const descInput = page.locator('input[placeholder*="e.g. Paid"]')
  await descInput.waitFor({ state: 'visible', timeout: 5000 })
  await descInput.click()
  await descInput.fill(b.desc)

  // Step 3: Amount — placeholder="0"
  console.log(`  Amount: RWF ${b.amount}`)
  const amtInput = page.locator('input[placeholder="0"]')
  await amtInput.waitFor({ state: 'visible', timeout: 5000 })
  await amtInput.click()
  await page.keyboard.press('Control+a')
  await amtInput.fill(b.amount)

  // Step 4: Payment method
  if (b.pay !== 'Cash') {
    console.log(`  Payment: ${b.pay}`)
    // Payment select is 3rd select (index 2), has "Cash" selected by default
    const paySelect = page.locator('select').nth(2)
    if (await paySelect.isVisible({ timeout: 2000 }).catch(() => false)) {
      const opts = await paySelect.locator('option').allTextContents()
      const mmOpt = opts.find(o => /mobile money/i.test(o))
      if (mmOpt) {
        await paySelect.selectOption({ label: mmOpt })
      } else {
        console.log(`  ⚠ Mobile Money not in options: ${opts.join(', ')}`)
      }
    }
  }

  await shot(page, `${slug}-02-form-filled`)

  // Step 5: Save — press Enter ("Enter to save & continue")
  console.log('  Saving (Enter)...')
  await page.keyboard.press('Enter')
  await waitLoaded(page)
  await shot(page, `${slug}-03-saved`)
  console.log(`  ✓ "${b.desc}" RWF ${b.amount} via ${b.pay}`)
}

await shot(page, 'zz-final')
await browser.close()
console.log(`\n── ALL DONE — ${OUT}`)
