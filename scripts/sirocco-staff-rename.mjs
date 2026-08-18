// Rename a Sirocco y Sol staff member. Dry run unless --execute.
//   node scripts/sirocco-staff-rename.mjs --from Phionah --to Fiona [--execute]
//
// Staff.name is also denormalised onto RestaurantOrder.createdByName (the waiter
// who rang the order up), so this reports any orders still carrying the old name
// and rewrites them too — otherwise past sales would be attributed to a name
// that no longer exists on the staff list.
import fs from 'fs'

const arg = (flag) => {
  const i = process.argv.indexOf(flag)
  return i !== -1 ? process.argv[i + 1] : null
}
const FROM = arg('--from')
const TO = arg('--to')
const EXECUTE = process.argv.includes('--execute')
if (!FROM || !TO) {
  console.error('usage: --from <current name> --to <new name> [--execute]')
  process.exit(1)
}

const env = {}
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/)
  if (m) env[m[1]] = m[2]
}
for (const k of ['DATABASE_URL', 'DIRECT_URL']) if (env[k]) process.env[k] = env[k]

const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
console.log(`MODE: ${EXECUTE ? '*** EXECUTE ***' : 'dry run (no writes)'}`)
console.log('DB host:', (process.env.DATABASE_URL || '').match(/@([^/:?]+)/)?.[1] ?? '(none)', '\n')

const r = await p.restaurant.findFirst({
  where: { name: { contains: 'rocco', mode: 'insensitive' } },
  select: { id: true, name: true },
})
if (!r) { console.log('No Sirocco restaurant.'); await p.$disconnect(); process.exit(0) }

const matches = await p.staff.findMany({
  where: { restaurantId: r.id, name: { equals: FROM, mode: 'insensitive' }, deletedAt: null },
  select: { id: true, name: true, role: true, phone: true, isActive: true, pin: true, cancellationPin: true },
})

console.log(`staff matching "${FROM}" in ${r.name}: ${matches.length}`)
for (const s of matches) {
  console.log(`  ${s.name}  role=${s.role}  phone=${s.phone ?? '—'}  active=${s.isActive}  orderCode=${s.pin ? 'set' : 'none'}  supervisorPin=${s.cancellationPin ? 'set' : 'none'}`)
}
if (!matches.length) {
  const all = await p.staff.findMany({ where: { restaurantId: r.id, deletedAt: null }, select: { name: true, role: true } })
  console.log('\nall staff:', all.map(s => `${s.name} (${s.role})`).join(', '))
  await p.$disconnect()
  process.exit(0)
}

// Would the new name collide with someone already on the list?
const clash = await p.staff.findFirst({
  where: { restaurantId: r.id, name: { equals: TO, mode: 'insensitive' }, deletedAt: null },
  select: { id: true, name: true },
})
if (clash && !matches.some(m => m.id === clash.id)) {
  console.log(`\nREFUSING: "${clash.name}" already exists on this restaurant's staff list.`)
  await p.$disconnect()
  process.exit(1)
}

const staleOrders = await p.restaurantOrder.count({
  where: { restaurantId: r.id, createdByName: { equals: FROM, mode: 'insensitive' } },
})
console.log(`\norders still crediting "${FROM}": ${staleOrders}`)

if (!EXECUTE) {
  console.log(`\nWould rename ${matches.length} staff row(s) "${FROM}" -> "${TO}"${staleOrders ? ` and re-credit ${staleOrders} order(s)` : ''}.`)
  console.log('Dry run — nothing written. Re-run with --execute.')
  await p.$disconnect()
  process.exit(0)
}

for (const s of matches) {
  await p.staff.update({ where: { id: s.id }, data: { name: TO } })
  console.log(`renamed staff ${s.id}: "${s.name}" -> "${TO}"`)
}
if (staleOrders > 0) {
  const res = await p.restaurantOrder.updateMany({
    where: { restaurantId: r.id, createdByName: { equals: FROM, mode: 'insensitive' } },
    data: { createdByName: TO },
  })
  console.log(`re-credited ${res.count} order(s)`)
}

const after = await p.staff.findMany({
  where: { restaurantId: r.id, deletedAt: null },
  select: { name: true, role: true },
  orderBy: { name: 'asc' },
})
console.log('\nstaff now:', after.map(s => `${s.name} (${s.role})`).join(', '))

await p.$disconnect()
