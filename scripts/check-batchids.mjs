import { createRequire } from 'module'; import { resolve } from 'path'; import { readFileSync } from 'fs'
for (const f of ['.env.local','.env']) { try { for (const l of readFileSync(resolve(process.cwd(),f),'utf8').split('\n')) { const t=l.trim(); if(!t||t.startsWith('#'))continue; const e=t.indexOf('='); if(e<0)continue; const k=t.slice(0,e).trim(), v=t.slice(e+1).trim().replace(/^['"]|['"]$/g,''); if(!process.env[k])process.env[k]=v } } catch{} }
const require = createRequire(import.meta.url); const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })
const user = await prisma.user.findUnique({ where:{ email:'high5ive@management.com' }, select:{ id:true } })
const rest = await prisma.restaurant.findFirst({ where:{ ownerId:user.id }, select:{ id:true } })
const branches = await prisma.branch.findMany({ where:{ restaurantId:rest.id }, select:{ id:true, name:true } })
for (const b of branches) {
  const purchases = await prisma.inventoryPurchase.findMany({ where:{ branchId:b.id, deletedAt:null }, select:{ batchId:true, purchasedAt:true } })
  if (!purchases.length) continue
  const byBatch = {}
  for (const p of purchases) { const k = p.batchId ?? 'NULL'; byBatch[k] = (byBatch[k]??0)+1 }
  console.log(`${b.name}:`); for (const [k,c] of Object.entries(byBatch)) console.log(`   batchId=${k}: ${c} purchases`)
}
await prisma.$disconnect()
