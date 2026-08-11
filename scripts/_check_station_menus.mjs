import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'
function env(k){const c=fs.readFileSync('.env.local','utf8');const l=c.split('\n').find(x=>x.startsWith(k+'='));return l?l.slice(k.length+1).trim().replace(/^"|"$/g,''):null}
const prisma = new PrismaClient({ datasources: { db: { url: env('DATABASE_URL') } } })
const u = await prisma.user.findMany({ where: { email: { endsWith: '@management.com' } }, select: { id: true } })
const rs = await prisma.restaurant.findMany({ where: { OR: [{ ownerId: { in: u.map(x=>x.id) } }, { managerId: { in: u.map(x=>x.id) } }] }, select: { id: true, name: true } })
for (const r of rs) {
  console.log(`\nRESTAURANT: ${r.name}`)
  const branches = await prisma.branch.findMany({
    where: { restaurantId: r.id, isActive: true },
    orderBy: [{ isMain: 'desc' }, { name: 'asc' }],
    select: { id: true, name: true, isMain: true },
  })
  for (const b of branches) {
    const dishes = await prisma.dish.findMany({
      where: { branchId: b.id, deletedAt: null },
      select: { category: true, isActive: true },
    })
    const cats = new Map()
    for (const d of dishes) {
      const k = (d.category ?? '').trim() || 'Uncategorised'
      cats.set(k, (cats.get(k) ?? 0) + 1)
    }
    const hidden = dishes.filter(d => !d.isActive).length
    console.log(`  ${b.name}${b.isMain ? ' (main)' : ''} — ${dishes.length} dishes, ${cats.size} categories${hidden ? `, ${hidden} hidden` : ''}`)
    for (const [c, n] of [...cats.entries()].sort((a,b)=>b[1]-a[1])) console.log(`      ${c}: ${n}`)
  }
}
await prisma.$disconnect()
