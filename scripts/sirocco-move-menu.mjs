// Moves SIROCCO Y SOL's dishes from the Main (kitchen) station to the
// COFFEE&BEVERAGE MANU (bar) station. Writes a reverse map BEFORE touching
// anything so the move can be undone dish-by-dish.
//
// Safe because every affected dish has no ingredients, variants, order items
// or dish sales — only Dish.branchId changes. Run with --apply to write;
// without it, prints the plan and exits.
import fs from 'fs'
import path from 'path'

const env = {}
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/)
  if (m) env[m[1]] = m[2]
}
for (const k of ['DATABASE_URL', 'DIRECT_URL']) if (env[k]) process.env[k] = env[k]

const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()

const FROM_BRANCH = 'cmssn2wkn000410rc5509vs7v' // Main [kitchen]
const TO_BRANCH   = 'cmssorj59001qeab2zd2w07bo' // COFFEE&BEVERAGE MANU [bar]
const APPLY = process.argv.includes('--apply')

const dishes = await p.dish.findMany({
  where: { branchId: FROM_BRANCH, deletedAt: null },
  select: { id: true, name: true, category: true, branchId: true,
            _count: { select: { ingredients: true, variants: true, orderItems: true, dishSales: true } } },
  orderBy: [{ category: 'asc' }, { name: 'asc' }],
})

// Refuse to touch anything carrying history — those need a considered decision.
const withHistory = dishes.filter(d => d._count.orderItems > 0 || d._count.dishSales > 0)
if (withHistory.length) {
  console.error('ABORT — these dishes have order/sales history:')
  for (const d of withHistory) console.error(`  ${d.name} (ord:${d._count.orderItems} sales:${d._count.dishSales})`)
  await p.$disconnect()
  process.exit(1)
}

console.log(`${dishes.length} dishes to move: Main -> COFFEE&BEVERAGE MANU`)
for (const d of dishes) console.log(`  ${(d.category ?? '-').padEnd(18)} ${d.name}`)

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to perform the move.')
  await p.$disconnect()
  process.exit(0)
}

const stamp = new Date().toISOString().slice(0, 10)
const mapFile = path.join('scripts', `.sirocco-move-reverse-${stamp}.json`)
fs.writeFileSync(mapFile, JSON.stringify({
  movedAt: new Date().toISOString(),
  fromBranchId: FROM_BRANCH,
  toBranchId: TO_BRANCH,
  dishes: dishes.map(d => ({ id: d.id, name: d.name, category: d.category, originalBranchId: d.branchId })),
}, null, 2))
console.log(`\nReverse map written: ${mapFile}`)

const result = await p.dish.updateMany({
  where: { id: { in: dishes.map(d => d.id) } },
  data: { branchId: TO_BRANCH },
})
console.log(`Updated ${result.count} dishes.`)

for (const id of [FROM_BRANCH, TO_BRANCH]) {
  const b = await p.branch.findUnique({ where: { id }, select: { name: true, type: true } })
  const n = await p.dish.count({ where: { branchId: id, deletedAt: null } })
  console.log(`  ${b.name} [${b.type}]: ${n} dishes`)
}

await p.$disconnect()
