import { createRequire } from 'module'; import { resolve } from 'path'; import { readFileSync } from 'fs'
for (const f of ['.env.local','.env']) { try { for (const l of readFileSync(resolve(process.cwd(),f),'utf8').split('\n')) { const t=l.trim(); if(!t||t.startsWith('#'))continue; const e=t.indexOf('='); if(e<0)continue; const k=t.slice(0,e).trim(), v=t.slice(e+1).trim().replace(/^['"]|['"]$/g,''); if(!process.env[k])process.env[k]=v } } catch{} }
const require = createRequire(import.meta.url)
const { PrismaClient } = require('@prisma/client')
const p = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })

const branch = await p.branch.findFirst({ where: { name: 'Banana Bar' }, select: { id: true, restaurantId: true } })
const exists = await p.dish.findFirst({ where: { branchId: branch.id, name: 'Gin & Tonic', deletedAt: null } })
if (exists) { console.log('Already exists'); } else {
  await p.dish.create({ data: { restaurantId: branch.restaurantId, branchId: branch.id, name: 'Gin & Tonic', category: 'Cocktails', sellingPrice: 15000, isActive: true } })
  console.log('Added: Gin & Tonic — 15,000 to Banana Bar')
}
await p.$disconnect()
