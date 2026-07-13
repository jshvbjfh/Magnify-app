// Phase 3 dry-run harness for the stock entry queue redesign.
//
// Drives the REAL /api/restaurant/inventory-purchases endpoint the same way
// the client queue does (client-generated id + stamped branch), including
// deliberate abuse: exact replays, concurrent duplicate sends, and an invalid
// station. Then verifies the books directly in the database.
//
// Usage:
//   DATABASE_URL=file:<scratch>.db BASE_URL=http://localhost:3401 node scripts/dryrun-stock-queue.mjs
//
// NEVER point DATABASE_URL at production for this: it creates test data.

import { PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3401'
const databaseUrl = String(process.env.DATABASE_URL || '')
if (!databaseUrl.startsWith('file:')) {
  console.error('Refusing to run: DATABASE_URL must be a local file: SQLite database.')
  process.exit(1)
}

const prisma = new PrismaClient()
const results = { passed: 0, failed: 0 }

function check(label, condition, detail = '') {
  if (condition) {
    results.passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    results.failed += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function newTicketId() {
  return `sp_${randomUUID().replace(/-/g, '')}`
}

// ── Minimal cookie jar ───────────────────────────────────────────────────────
const jar = new Map()
function storeCookies(response) {
  const cookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : []
  for (const cookie of cookies) {
    const [pair] = cookie.split(';')
    const eq = pair.indexOf('=')
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
  }
}
function cookieHeader() {
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join('; ')
}
async function http(path, init = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { ...(init.headers || {}), cookie: cookieHeader() },
    redirect: 'manual',
  })
  storeCookies(response)
  return response
}

// ── Auth setup ───────────────────────────────────────────────────────────────
async function signupAndLogin() {
  const email = `dryrun-${Date.now()}@test.local`
  const password = 'dryrun-password-123'

  const signup = await http('/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Dry Run Manager', email, password }),
  })
  if (!signup.ok) {
    throw new Error(`Signup failed (${signup.status}): ${await signup.text()}`)
  }

  // New accounts start inactive; activate the throwaway test user directly.
  await prisma.user.update({ where: { email }, data: { isActive: true } })

  const csrfResponse = await http('/api/auth/csrf')
  const { csrfToken } = await csrfResponse.json()

  const login = await http('/api/auth/callback/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrfToken, email, password, json: 'true' }).toString(),
  })
  if (login.status >= 400) {
    throw new Error(`Login failed (${login.status}): ${await login.text()}`)
  }

  const session = await (await http('/api/auth/session')).json()
  if (!session?.user) throw new Error('No session after login')

  const user = await prisma.user.findUnique({ where: { email } })
  const restaurant = await prisma.restaurant.findFirst({ where: { ownerId: user.id } })
  const branch = await prisma.branch.findFirst({ where: { restaurantId: restaurant.id, isMain: true } })
  if (!branch) throw new Error('No main branch created by signup')
  return { restaurantId: restaurant.id, branchId: branch.id }
}

// ── Stock entry sender (mirrors the client queue payload exactly) ───────────
function makeEntry({ id, branchId, itemName, unit = 'L', qty = 20, cost = 100, paymentMethod = 'Cash', batch = 'B-20260713-DRY', ingredientId }) {
  return {
    id,
    branchId,
    batchId: batch,
    ...(ingredientId ? { ingredientId } : {}),
    itemName,
    unit,
    purchaseUnit: unit,
    unitsPerPurchaseUnit: 1,
    supplier: 'Dry Run Supplier',
    paymentMethod,
    purchaseQuantity: qty,
    purchaseUnitCost: cost,
    purchasedAt: '2026-07-13',
  }
}

async function sendEntry(entry) {
  const startedAt = Date.now()
  const response = await http('/api/restaurant/inventory-purchases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  })
  const body = await response.json().catch(() => null)
  return { status: response.status, body, ms: Date.now() - startedAt }
}

// ── The dry run ──────────────────────────────────────────────────────────────
async function main() {
  console.log(`Dry run against ${BASE_URL}`)
  const { restaurantId, branchId } = await signupAndLogin()
  console.log(`Test restaurant ${restaurantId}, station ${branchId}\n`)

  const itemNames = ['Dry Oil', 'Dry Rice', 'Dry Flour', 'Dry Sugar', 'Dry Salt', 'Dry Beans']
  const sentIds = []
  const timings = []

  // 1) Burst: 12 sequential entries — 6 new items, then 6 repeats of the same
  //    items (second round mimics the client sending ingredientId when known).
  console.log('1) Burst of 12 sequential entries')
  for (let round = 0; round < 2; round += 1) {
    for (const [index, itemName] of itemNames.entries()) {
      let ingredientId
      if (round === 1) {
        const item = await prisma.inventoryItem.findFirst({ where: { restaurantId, name: itemName } })
        ingredientId = item?.id
      }
      const id = newTicketId()
      const entry = makeEntry({
        id,
        branchId,
        itemName,
        qty: 10 + index,
        cost: 50 + index * 10,
        paymentMethod: index % 3 === 0 ? 'Mobile Money' : 'Cash',
        ingredientId,
      })
      const { status, ms } = await sendEntry(entry)
      timings.push(ms)
      if (status !== 201) {
        check(`entry ${itemName} round ${round + 1} saves`, false, `status ${status}`)
      } else {
        sentIds.push(id)
      }
    }
  }
  check('all 12 burst entries returned 201', sentIds.length === 12, `${sentIds.length}/12`)
  const avgMs = Math.round(timings.reduce((s, t) => s + t, 0) / timings.length)
  console.log(`  timing: avg ${avgMs}ms, max ${Math.max(...timings)}ms per save (localhost+SQLite)\n`)

  // 2) Exact replay of an already-committed entry (crash/timeout retry).
  console.log('2) Replay of an already-committed entry')
  const replayTarget = makeEntry({ id: sentIds[2], branchId, itemName: 'Dry Flour', qty: 12, cost: 70 })
  const replay = await sendEntry(replayTarget)
  check('replay returns success (not an error)', replay.status === 200 || replay.status === 201, `status ${replay.status}`)
  check('replay flagged alreadySaved', replay.body?.alreadySaved === true)

  // 3) Concurrent duplicate: same brand-new id fired twice simultaneously.
  console.log('\n3) Concurrent duplicate send (same id, two requests at once)')
  const dupId = newTicketId()
  const dupEntry = makeEntry({ id: dupId, branchId, itemName: 'Dry Oil', qty: 5, cost: 100 })
  const [first, second] = await Promise.all([sendEntry(dupEntry), sendEntry(dupEntry)])
  const statuses = [first.status, second.status].sort()
  check('both duplicate requests end in success', statuses.every((s) => s === 200 || s === 201), `statuses ${statuses.join(',')}`)
  sentIds.push(dupId)

  // 4) Invalid station stamp must be rejected cleanly.
  console.log('\n4) Entry stamped with an unknown station')
  const badBranch = await sendEntry(makeEntry({ id: newTicketId(), branchId: 'branch-does-not-exist', itemName: 'Dry Oil' }))
  check('unknown station rejected with 400', badBranch.status === 400, `status ${badBranch.status}`)
  check('unknown station message is one line', badBranch.body?.error === 'Station not found for this entry', String(badBranch.body?.error))

  // 5) Invalid payload must be rejected before any write.
  console.log('\n5) Invalid payload (quantity 0)')
  const badQty = await sendEntry(makeEntry({ id: newTicketId(), branchId, itemName: 'Dry Oil', qty: 0 }))
  check('zero quantity rejected with 400', badQty.status === 400, `status ${badQty.status}`)

  // ── Database verification ──────────────────────────────────────────────────
  console.log('\n6) Database invariants')
  const purchases = await prisma.inventoryPurchase.findMany({ where: { restaurantId } })
  check(`exactly ${sentIds.length} purchases exist (no duplicates, no losses)`, purchases.length === sentIds.length, `found ${purchases.length}`)
  check('every sent id committed exactly once', sentIds.every((id) => purchases.filter((p) => p.id === id).length === 1))
  check('every purchase landed in the stamped station', purchases.every((p) => p.branchId === branchId))
  check('every purchase has a journal entry', purchases.every((p) => p.journalEntryId))

  const journalEntries = await prisma.journalEntry.findMany({
    where: { restaurantId },
    include: { lines: true },
  })
  check('journal entry count equals purchase count (replays booked nothing extra)', journalEntries.length === purchases.length, `${journalEntries.length} vs ${purchases.length}`)
  check('every journal entry has exactly 2 lines', journalEntries.every((entry) => entry.lines.length === 2))
  const allBalanced = journalEntries.every((entry) => {
    const debit = entry.lines.reduce((sum, line) => sum + line.debit, 0)
    const credit = entry.lines.reduce((sum, line) => sum + line.credit, 0)
    return Math.abs(debit - credit) < 0.001 && debit > 0
  })
  check('every journal entry is balanced (debit = credit)', allBalanced)

  const journalTotal = journalEntries.reduce((sum, entry) => sum + entry.lines.reduce((s, l) => s + l.debit, 0), 0)
  const purchaseTotal = purchases.reduce((sum, p) => sum + p.totalCost, 0)
  check('booked expense total equals purchase total', Math.abs(journalTotal - purchaseTotal) < 0.001, `${journalTotal} vs ${purchaseTotal}`)

  const items = await prisma.inventoryItem.findMany({ where: { restaurantId } })
  check(`exactly ${itemNames.length} inventory items exist (name matching merged repeats)`, items.length === itemNames.length, `found ${items.length}`)
  const stockMatches = items.every((item) => {
    const layerSum = purchases.filter((p) => p.ingredientId === item.id).reduce((sum, p) => sum + p.remainingQuantity, 0)
    return Math.abs(layerSum - item.quantity) < 0.001
  })
  check('every item quantity equals the sum of its FIFO layers', stockMatches)

  console.log(`\nResult: ${results.passed} passed, ${results.failed} failed`)
  process.exit(results.failed === 0 ? 0 : 1)
}

main()
  .catch((error) => {
    console.error('Dry run crashed:', error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
