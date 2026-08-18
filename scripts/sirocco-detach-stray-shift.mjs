// Detach the shift that was opened at SIROCCO Y SOL by mistake on 2026-08-18.
//
// The venue runs with shiftsEnabled=false, but production did not yet send that
// flag to the till, so the app's fail-closed default kept the shift gate up and
// a supervisor opened a shift at 09:19. One order taken a minute later was
// stamped with it and with business date 2026-08-17 -- the day BEFORE it was
// taken. Left alone, that order would report on the 17th once it is paid, while
// the seven orders taken earlier that morning (correctly carrying no shift)
// report on their real paid date. Same morning, two different days.
//
// So: clear the shift and business date off the affected order, and close the
// shift so nothing else attaches to it and pull stops advertising it as open.
//
// Deliberately narrow. It touches ONE shift id and only the orders stamped with
// it, never a status, an amount, or an order that was already settled inside a
// legitimate shift. Re-runnable: a second run finds nothing left to do.
//
// Dry run by default. Pass --apply to write.

import fs from 'fs'

const APPLY = process.argv.includes('--apply')
const SHIFT_ID = '5202aa58-42f4-4ee7-be9b-34a7777a79de'
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

const shift = await prisma.shift.findUnique({
  where: { id: SHIFT_ID },
  select: {
    id: true, restaurantId: true, status: true, businessDate: true,
    openedAt: true, closedAt: true, openedByName: true,
  },
})

if (!shift) {
  console.log('Shift not found — nothing to do.')
  await prisma.$disconnect()
  process.exit(0)
}

const restaurant = await prisma.restaurant.findUnique({
  where: { id: shift.restaurantId },
  select: { name: true, shiftsEnabled: true },
})

// Guard: refuse to touch anything but the account this was written for.
if (restaurant?.name !== RESTAURANT_NAME) {
  console.error(`REFUSING: shift belongs to "${restaurant?.name}", not ${RESTAURANT_NAME}.`)
  await prisma.$disconnect()
  process.exit(1)
}

console.log(`Restaurant : ${restaurant.name} (shiftsEnabled=${restaurant.shiftsEnabled})`)
console.log(`Shift      : ${shift.id}`)
console.log(`  status=${shift.status} businessDate=${shift.businessDate?.toISOString().slice(0, 10)}`)
console.log(`  opened=${shift.openedAt?.toISOString().slice(0, 16)} by ${shift.openedByName} closed=${shift.closedAt?.toISOString().slice(0, 16) ?? '-'}`)

const orders = await prisma.restaurantOrder.findMany({
  where: { shiftId: SHIFT_ID },
  select: {
    id: true, orderNumber: true, status: true, totalAmount: true,
    businessDate: true, paidAt: true, createdAt: true, createdByName: true,
  },
  orderBy: { createdAt: 'asc' },
})

console.log(`\nOrders stamped with this shift: ${orders.length}`)
for (const o of orders) {
  console.log(`  #${o.orderNumber}  ${o.status}  total=${o.totalAmount}  by ${o.createdByName}`)
  console.log(`     created=${o.createdAt.toISOString().slice(0, 16)}  paid=${o.paidAt?.toISOString().slice(0, 16) ?? '-'}`)
  console.log(`     shiftId : ${SHIFT_ID}  ->  null`)
  console.log(`     bizDate : ${o.businessDate?.toISOString().slice(0, 10) ?? 'null'}  ->  null   (reports by paidAt instead)`)
}

const settled = orders.filter((o) => o.status === 'PAID')
if (settled.length > 0) {
  console.log(`\n!! ${settled.length} of these are already PAID. Clearing their business date MOVES revenue between days in reports:`)
  for (const o of settled) {
    console.log(`   #${o.orderNumber} ${o.totalAmount}: reports on ${o.businessDate?.toISOString().slice(0, 10)} -> ${o.paidAt?.toISOString().slice(0, 10)}`)
  }
  console.log('   Review these before applying.')
}

console.log(`\nShift ${shift.id}: status ${shift.status} -> CLOSED`)

if (!APPLY) {
  console.log('\nDry run complete. Re-run with --apply to write.')
  await prisma.$disconnect()
  process.exit(0)
}

const result = await prisma.$transaction(async (tx) => {
  const detached = await tx.restaurantOrder.updateMany({
    where: { shiftId: SHIFT_ID },
    data: { shiftId: null, businessDate: null },
  })
  const closed = await tx.shift.update({
    where: { id: SHIFT_ID },
    data: { status: 'CLOSED', closedAt: new Date(), closedByName: 'Cleanup — opened in error' },
    select: { id: true, status: true },
  })
  return { detached: detached.count, closed }
})

console.log(`\nDone. Orders detached: ${result.detached}. Shift ${result.closed.id} is now ${result.closed.status}.`)

await prisma.$disconnect()
