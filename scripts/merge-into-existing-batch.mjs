import { createRequire } from 'module'; import { resolve } from 'path'; import { readFileSync } from 'fs'
for (const f of ['.env.local','.env']) { try { for (const l of readFileSync(resolve(process.cwd(),f),'utf8').split('\n')) { const t=l.trim(); if(!t||t.startsWith('#'))continue; const e=t.indexOf('='); if(e<0)continue; const k=t.slice(0,e).trim(), v=t.slice(e+1).trim().replace(/^['"]|['"]$/g,''); if(!process.env[k])process.env[k]=v } } catch{} }
const require = createRequire(import.meta.url); const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })
const COMMIT = process.argv.includes('--commit')
const user = await prisma.user.findUnique({ where:{ email:'high5ive@management.com' }, select:{ id:true } })
const rest = await prisma.restaurant.findFirst({ where:{ ownerId:user.id }, select:{ id:true } })
const branches = await prisma.branch.findMany({ where:{ restaurantId:rest.id }, select:{ id:true, name:true } })
console.log(COMMIT ? '🟢 COMMIT' : '🟡 DRY RUN', '— merge NULL-batch purchases into existing batch\n')
for (const b of branches) {
  const existing = await prisma.inventoryPurchase.findFirst({ where:{ branchId:b.id, deletedAt:null, batchId:{ not:null } }, select:{ batchId:true } })
  const orphans = await prisma.inventoryPurchase.findMany({ where:{ branchId:b.id, deletedAt:null, batchId:null }, select:{ id:true, ingredient:{select:{name:true}} } })
  if (!orphans.length) continue
  if (!existing) { console.log(`${b.name}: no existing batchId found — SKIP (${orphans.length} orphans)`); continue }
  console.log(`${b.name}: moving ${orphans.length} -> ${existing.batchId} (${orphans.map(o=>o.ingredient.name).join(', ')})`)
  if (COMMIT) await prisma.inventoryPurchase.updateMany({ where:{ branchId:b.id, deletedAt:null, batchId:null }, data:{ batchId: existing.batchId } })
}
console.log(`\n${COMMIT ? 'Committed.' : 'Dry run — re-run with --commit.'}`)
await prisma.$disconnect()
