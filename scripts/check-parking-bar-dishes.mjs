import { createRequire } from 'module'; import { resolve } from 'path'; import { readFileSync } from 'fs'
for (const f of ['.env.local','.env']) { try { for (const l of readFileSync(resolve(process.cwd(),f),'utf8').split('\n')) { const t=l.trim(); if(!t||t.startsWith('#'))continue; const e=t.indexOf('='); if(e<0)continue; const k=t.slice(0,e).trim(), v=t.slice(e+1).trim().replace(/^['"]|['"]$/g,''); if(!process.env[k])process.env[k]=v } } catch{} }
const require = createRequire(import.meta.url)
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })

const branch = await p.branch.findFirst({ where: { name: 'Banana Bar' }, select: { id: true } })
const dishes = await p.dish.findMany({
  where: { branchId: branch.id, deletedAt: null },
  select: { name: true, category: true, sellingPrice: true },
  orderBy: [{ category: 'asc' }, { name: 'asc' }]
})
const byCategory = {}
for (const d of dishes) {
  const cat = d.category || '(no category)'
  if (!byCategory[cat]) byCategory[cat] = []
  byCategory[cat].push(d)
}
for (const [cat, items] of Object.entries(byCategory)) {
  console.log(`\n[${cat}]`)
  for (const d of items) console.log(`  ${d.name} — ${d.sellingPrice}`)
}
console.log(`\nTotal dishes: ${dishes.length}`)
await p.$disconnect()
