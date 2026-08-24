// READ-ONLY survey of High 5ive's paid orders, to see what an APC demo has to
// work with. Writes nothing.
//
// APC on the dashboard is per STATION and per date range:
//   sum(totalAmount) / sum(guestCount), over PAID orders that carry a guest
//   count. Orders without one are excluded from both sides of the division.
// So the numbers only appear for the station and period the investor is shown.

import fs from 'fs'

const env = {}
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/)
  if (m) env[m[1]] = m[2]
}
for (const k of ['DATABASE_URL', 'DIRECT_URL']) if (env[k]) process.env[k] = env[k]

const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient()

const user = await prisma.user.findFirst({
  where: { email: 'high5ive@management.com' },
  select: { id: true, role: true },
})
if (!user) {
  console.log('No user with that email.')
  await prisma.$disconnect()
  process.exit(0)
}

const restaurants = await prisma.restaurant.findMany({
  where: { OR: [{ ownerId: user.id }, { managerId: user.id }], deletedAt: null },
  select: { id: true, name: true, branches: { select: { id: true, name: true, isMain: true } } },
})

for (const r of restaurants) {
  console.log(`\n=== ${r.name} (${r.id}) ===`)
  for (const b of r.branches) {
    const paid = await prisma.restaurantOrder.findMany({
      where: { restaurantId: r.id, branchId: b.id, status: 'PAID', deletedAt: null },
      select: { id: true, totalAmount: true, guestCount: true, paidAt: true },
      orderBy: { paidAt: 'asc' },
    })
    if (!paid.length) continue
    const withGuests = paid.filter((o) => (o.guestCount ?? 0) > 0)
    const revenue = paid.reduce((s, o) => s + (o.totalAmount ?? 0), 0)
    const first = paid[0].paidAt?.toISOString().slice(0, 10)
    const last = paid[paid.length - 1].paidAt?.toISOString().slice(0, 10)
    console.log(`\n  station: ${b.name}${b.isMain ? ' [MAIN]' : ''}`)
    console.log(`    paid orders : ${paid.length}   with a guest count: ${withGuests.length}`)
    console.log(`    revenue     : ${revenue.toLocaleString()}   ${first} → ${last}`)
    const avgBill = revenue / paid.length
    console.log(`    average bill: ${Math.round(avgBill).toLocaleString()}`)
    // What APC would read today, if anything.
    if (withGuests.length) {
      const g = withGuests.reduce((s, o) => s + o.guestCount, 0)
      const rev = withGuests.reduce((s, o) => s + (o.totalAmount ?? 0), 0)
      console.log(`    APC today   : ${Math.round(rev / g).toLocaleString()} over ${g} covers`)
    } else {
      console.log('    APC today   : nothing — no order carries a guest count')
    }
    // Bill spread tells us what a believable party size looks like.
    const sorted = paid.map((o) => o.totalAmount ?? 0).sort((a, b2) => a - b2)
    const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
    console.log(`    bills       : min ${sorted[0].toLocaleString()} | p50 ${at(0.5).toLocaleString()} | p90 ${at(0.9).toLocaleString()} | max ${sorted[sorted.length - 1].toLocaleString()}`)
  }
}

await prisma.$disconnect()
