// Fill in guest counts on High 5ive's paid orders so the dashboard's APC card
// has something to show an investor.
//
// WHAT IS REAL AND WHAT IS NOT: the orders, the dishes and the revenue are all
// genuine trading history. The covers are invented by this script. APC is
// revenue divided by covers, so the figure it produces is an illustration of
// how the report works, not a measured result. Worth saying plainly to whoever
// is being shown it.
//
// Only guestCount is written. It is a nullable analytics field that no money
// path reads — totals, journal entries, dish sales and stock are untouched, so
// nothing about the accounts changes.
//
// Covers are derived from each bill rather than drawn at random, because random
// covers produce a nonsense APC: a 3,000 RWF bill with 9 guests reads as 333 a
// head. Each order gets a per-head spend drawn from a believable band and the
// party size follows from the bill, which keeps APC inside that band while the
// party sizes still vary order to order.
//
// Deterministic: the same order always gets the same number, so re-running
// changes nothing and the demo is reproducible.
//
// Dry run by default. --apply writes. --clear puts every guestCount back to
// null, so the demo can be undone completely.

import fs from 'fs'

const APPLY = process.argv.includes('--apply')
const CLEAR = process.argv.includes('--clear')
const OWNER_EMAIL = 'high5ive@management.com'
const RESTAURANT_NAME = 'High 5ive'

// A cover at this venue spends somewhere in this band. Bills here run from a
// couple of thousand to 155,000, so this puts most parties at one to six.
const MIN_PER_HEAD = 9000
const MAX_PER_HEAD = 17000
const MAX_PARTY = 10

const env = {}
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/)
  if (m) env[m[1]] = m[2]
}
for (const k of ['DATABASE_URL', 'DIRECT_URL']) if (env[k]) process.env[k] = env[k]

const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient()

// Stable hash of the order id → the same order always draws the same per-head
// spend, so a second run is a no-op rather than a reshuffle.
function seededUnit(id) {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100000) / 100000
}

function coversFor(order) {
  const total = Number(order.totalAmount ?? 0)
  if (!Number.isFinite(total) || total <= 0) return 1
  const perHead = MIN_PER_HEAD + seededUnit(order.id) * (MAX_PER_HEAD - MIN_PER_HEAD)
  return Math.max(1, Math.min(MAX_PARTY, Math.round(total / perHead)))
}

const user = await prisma.user.findFirst({ where: { email: OWNER_EMAIL }, select: { id: true } })
if (!user) {
  console.log(`No user ${OWNER_EMAIL}.`)
  await prisma.$disconnect()
  process.exit(0)
}

const restaurant = await prisma.restaurant.findFirst({
  where: { OR: [{ ownerId: user.id }, { managerId: user.id }], deletedAt: null, name: RESTAURANT_NAME },
  select: { id: true, name: true, branches: { select: { id: true, name: true } } },
})
if (!restaurant) {
  console.log(`No restaurant named ${RESTAURANT_NAME} for that account — refusing to touch anything else.`)
  await prisma.$disconnect()
  process.exit(1)
}

console.log(`DB host: ${(process.env.DATABASE_URL || '').match(/@([^/:?]+)/)?.[1] ?? '(none)'}`)
console.log(`restaurant: ${restaurant.name}`)
console.log(CLEAR ? '\nMODE: CLEAR — every guestCount back to null' : '')
console.log(APPLY ? '*** APPLY MODE — writes will happen ***\n' : '--- DRY RUN — no writes ---\n')

if (CLEAR) {
  const n = await prisma.restaurantOrder.count({
    where: { restaurantId: restaurant.id, guestCount: { not: null } },
  })
  console.log(`${n} orders currently carry a guest count.`)
  if (APPLY) {
    const r = await prisma.restaurantOrder.updateMany({
      where: { restaurantId: restaurant.id },
      data: { guestCount: null },
    })
    console.log(`cleared ${r.count}`)
  } else {
    console.log('Re-run with --apply --clear to write.')
  }
  await prisma.$disconnect()
  process.exit(0)
}

let totalWritten = 0
for (const branch of restaurant.branches) {
  const orders = await prisma.restaurantOrder.findMany({
    where: {
      restaurantId: restaurant.id,
      branchId: branch.id,
      status: 'PAID',
      deletedAt: null,
    },
    select: { id: true, totalAmount: true, guestCount: true, paidAt: true },
    orderBy: { paidAt: 'asc' },
  })
  if (!orders.length) continue

  const planned = orders.map((o) => ({ order: o, covers: coversFor(o) }))
  const covers = planned.reduce((s, p) => s + p.covers, 0)
  const revenue = planned.reduce((s, p) => s + Number(p.order.totalAmount ?? 0), 0)
  const apc = covers > 0 ? revenue / covers : 0

  const sizes = {}
  for (const p of planned) sizes[p.covers] = (sizes[p.covers] ?? 0) + 1

  console.log(`${branch.name}`)
  console.log(`   orders ${orders.length}   covers ${covers}   revenue ${revenue.toLocaleString()}`)
  console.log(`   APC would read: ${Math.round(apc).toLocaleString()} RWF per cover`)
  console.log(`   party sizes: ${Object.keys(sizes).sort((a, b) => a - b).map((k) => `${k}p×${sizes[k]}`).join('  ')}`)
  console.log()

  if (APPLY) {
    for (const p of planned) {
      await prisma.restaurantOrder.update({
        where: { id: p.order.id },
        data: { guestCount: p.covers },
      })
      totalWritten++
    }
  }
}

if (APPLY) {
  console.log(`Done. guestCount written on ${totalWritten} paid orders.`)
} else {
  console.log('Dry run complete. Re-run with --apply to write.')
}

await prisma.$disconnect()
