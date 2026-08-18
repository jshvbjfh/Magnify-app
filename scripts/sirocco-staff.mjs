// Read-only: does SIROCCO Y SOL have a supervisor able to open a shift?
// Reports only WHETHER each PIN is set and its digit length — never the hash.
import fs from 'fs'

const env = {}
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/)
  if (m) env[m[1]] = m[2]
}
for (const k of ['DATABASE_URL', 'DIRECT_URL']) if (env[k]) process.env[k] = env[k]

const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()

const staff = await p.staff.findMany({
  where: { restaurantId: 'cmssn2wif000210rcxlzs1jny' },
  select: { id: true, name: true, username: true, role: true, isActive: true, deletedAt: true,
            pin: true, cancellationPin: true,
            branches: { select: { branch: { select: { name: true, type: true } } } } },
})

console.log(`${staff.length} staff record(s):\n`)
for (const s of staff) {
  console.log(`  name:            ${s.name}  (username: ${s.username ?? '-'})`)
  console.log(`  role:            ${s.role}`)
  console.log(`  active:          ${s.isActive}  deleted:${s.deletedAt ? 'YES' : 'no'}`)
  console.log(`  pin set:         ${s.pin ? 'yes' : 'NO'}`)
  console.log(`  cancellationPin: ${s.cancellationPin ? 'yes' : 'NO'}   <- the shift-start PIN`)
  console.log(`  branches:        ${s.branches.map(b => `${b.branch.name}[${b.branch.type}]`).join(', ') || '(none)'}\n`)
}

await p.$disconnect()
