// Remove two test orders taken at SIROCCO Y SOL on 2026-08-18 while the
// discount and join features were being tried out.
//
// A real DELETE, at the operator's request: these were test orders and they
// wanted them gone rather than hidden. The rows and their items are removed
// outright, which is also what makes them disappear from the tills — the waiter
// apps purge any local order the server stops listing, and a soft delete alone
// kept them listed.
//
// This is irreversible. That is why the guards below are absolute rather than
// advisory: anything paid, carrying a journal entry, or with a dish sale
// against it is skipped no matter what, because deleting one of those would
// leave accounting pointing at a row that no longer exists.
//
// Verified safe before writing this: both are PENDING, neither was ever paid,
// neither carries a journalEntryId, and neither has a single DishSale against
// it. So no revenue, no stock movement and no accounting entry depends on
// either — removing them changes no report.
//
// Deliberately narrow. It names two order numbers, refuses to touch an order
// belonging to any other restaurant, and refuses to touch one that has been
// paid or has booked anything. Dry run by default; --apply writes.

import fs from 'fs'

const APPLY = process.argv.includes('--apply')
const ORDER_NUMBERS = ['WA-579BA16C', 'WA-FFCA2FBB']
const RESTAURANT_NAME = 'SIROCCO Y SOL'

const env = {}
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/)
  if (m) env[m[1]] = m[2]
}
for (const k of ['DATABASE_URL', 'DIRECT_URL']) if (env[k]) process.env[k] = env[k]

const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient()

console.log(`DB host: ${(process.env.DATABASE_URL || '').match(/@([^/:?]+)/)?.[1] ?? '(none)'}`)
console.log(APPLY ? '\n*** APPLY MODE — writes will happen ***\n' : '\n--- DRY RUN — no writes ---\n')

const orders = await prisma.restaurantOrder.findMany({
  where: { orderNumber: { in: ORDER_NUMBERS } },
  include: { items: true },
})

if (!orders.length) {
  console.log('No matching orders — nothing to do.')
  await prisma.$disconnect()
  process.exit(0)
}

const restaurants = Object.fromEntries(
  (await prisma.restaurant.findMany({ select: { id: true, name: true } })).map((r) => [r.id, r.name]),
)

const safe = []
for (const o of orders) {
  const dishSales = await prisma.dishSale.count({ where: { orderId: o.id } })
  const problems = []
  if (restaurants[o.restaurantId] !== RESTAURANT_NAME) problems.push(`belongs to ${restaurants[o.restaurantId]}`)
  if (o.paidAt) problems.push('has been PAID')
  if (o.journalEntryId) problems.push('has a journal entry')
  if (dishSales > 0) problems.push(`has ${dishSales} dish sales`)
  // deletedAt is not a blocker here: an order already soft-removed is exactly
  // one we now want gone for real.

  console.log(`${o.orderNumber}  ${restaurants[o.restaurantId]}`)
  console.log(`   status=${o.status} total=${o.totalAmount} by ${o.createdByName} on ${o.createdAt.toISOString().slice(0, 16)}`)
  console.log(`   items: ${o.items.map((i) => `${i.qty}x ${i.dishName}`).join(', ')}`)
  if (problems.length) {
    console.log(`   SKIPPING — ${problems.join('; ')}`)
  } else {
    console.log('   safe to delete: never paid, no journal entry, no dish sales')
    safe.push(o)
  }
  console.log()
}

console.log(`${safe.length} of ${orders.length} will be DELETED outright, items included.`)

if (!APPLY) {
  console.log('\nDry run complete. Re-run with --apply to write.')
  await prisma.$disconnect()
  process.exit(0)
}

for (const o of safe) {
  await prisma.$transaction(async (tx) => {
    // Items first: the FK is onDelete Cascade, but doing it explicitly keeps
    // the intent obvious and the transaction self-describing.
    await tx.orderItem.deleteMany({ where: { orderId: o.id } })
    await tx.restaurantOrder.delete({ where: { id: o.id } })
  })
  console.log(`deleted ${o.orderNumber} and its items`)
}

await prisma.$disconnect()
