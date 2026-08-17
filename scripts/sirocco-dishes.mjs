// Read-only listing of SIROCCO Y SOL dishes per station. No writes.
import fs from 'fs'

const env = {}
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/)
  if (m) env[m[1]] = m[2]
}
for (const k of ['DATABASE_URL', 'DIRECT_URL']) if (env[k]) process.env[k] = env[k]

const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()

const RESTAURANT_ID = 'cmssn2wif000210rcxlzs1jny'

const branches = await p.branch.findMany({
  where: { restaurantId: RESTAURANT_ID, deletedAt: null },
  select: { id: true, name: true, type: true },
})

for (const b of branches) {
  const dishes = await p.dish.findMany({
    where: { branchId: b.id, deletedAt: null },
    select: { id: true, name: true, category: true, menuType: true, sellingPrice: true, isActive: true,
              _count: { select: { ingredients: true, variants: true, orderItems: true, dishSales: true } } },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
  })
  console.log(`\n=== ${b.name}  [${b.type}]  id=${b.id} — ${dishes.length} dishes ===`)
  for (const d of dishes) {
    const c = d._count
    const links = `ing:${c.ingredients} var:${c.variants} ord:${c.orderItems} sales:${c.dishSales}`
    console.log(
      `${(d.category ?? '(no category)').padEnd(22)} | ${d.name.padEnd(34)} | ${String(d.sellingPrice).padStart(8)} | ${(d.menuType ?? '-').padEnd(10)} | ${d.isActive ? 'active' : 'INACTIVE'} | ${links}`
    )
  }
}

await p.$disconnect()
