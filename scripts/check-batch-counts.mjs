import { createRequire } from 'module'; import { resolve } from 'path'; import { readFileSync } from 'fs'
for (const f of ['.env.local','.env']) { try { for (const l of readFileSync(resolve(process.cwd(),f),'utf8').split('\n')) { const t=l.trim(); if(!t||t.startsWith('#'))continue; const e=t.indexOf('='); if(e<0)continue; const k=t.slice(0,e).trim(), v=t.slice(e+1).trim().replace(/^['"]|['"]$/g,''); if(!process.env[k])process.env[k]=v } } catch{} }
const require = createRequire(import.meta.url); const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })
const user = await prisma.user.findUnique({ where:{ email:'high5ive@management.com' }, select:{ id:true } })
const rest = await prisma.restaurant.findFirst({ where:{ ownerId:user.id }, select:{ id:true } })
const items = await prisma.inventoryItem.findMany({ where:{ restaurantId:rest.id, deletedAt:null }, select:{ name:true, branch:{select:{name:true}}, purchases:{ where:{deletedAt:null}, select:{id:true} } } })
const multi = items.filter(i => i.purchases.length > 1)
const counts = { 0:0, 1:0, '2+':0 }
for (const i of items) { const n=i.purchases.length; if(n===0)counts[0]++; else if(n===1)counts[1]++; else counts['2+']++ }
console.log('Items by batch count:', counts)
console.log('Items with 2+ batches:', multi.length)
for (const i of multi) console.log(`  ${i.branch.name} / ${i.name}: ${i.purchases.length} batches`)
const created22 = await prisma.inventoryPurchase.count({ where:{ restaurantId:rest.id, purchasedAt:{ gte: new Date('2026-06-22T00:00:00Z') } } })
console.log('Batches dated 2026-06-22 (this session):', created22)
await prisma.$disconnect()
