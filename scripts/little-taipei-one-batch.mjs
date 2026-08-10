import { createRequire } from 'module'; import { resolve } from 'path'; import { readFileSync } from 'fs'
for (const f of ['.env.local','.env']) { try { for (const l of readFileSync(resolve(process.cwd(),f),'utf8').split('\n')) { const t=l.trim(); if(!t||t.startsWith('#'))continue; const e=t.indexOf('='); if(e<0)continue; const k=t.slice(0,e).trim(), v=t.slice(e+1).trim().replace(/^['"]|['"]$/g,''); if(!process.env[k])process.env[k]=v } } catch{} }
const require = createRequire(import.meta.url); const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })
const COMMIT = process.argv.includes('--commit')
const TARGET = 'B-06182026-0CD30D'
const user = await prisma.user.findUnique({ where:{ email:'high5ive@management.com' }, select:{ id:true } })
const rest = await prisma.restaurant.findFirst({ where:{ ownerId:user.id }, select:{ id:true } })
const branch = await prisma.branch.findFirst({ where:{ restaurantId:rest.id, name:'Little Taipei' }, select:{ id:true } })
console.log(COMMIT?'🟢 COMMIT':'🟡 DRY RUN', `— Little Taipei: all items into ${TARGET}\n`)

// 1. Active items with no active purchase -> create one under TARGET
const items = await prisma.inventoryItem.findMany({ where:{ branchId:branch.id, deletedAt:null }, select:{ id:true, name:true, quantity:true, unitCost:true, purchases:{ where:{ deletedAt:null }, select:{ id:true, batchId:true } } } })
for (const it of items) {
  if (it.purchases.length === 0) {
    console.log(`+ create batch entry for "${it.name}" (qty ${it.quantity}) -> ${TARGET}`)
    if (COMMIT) await prisma.inventoryPurchase.create({ data:{ restaurantId:rest.id, branchId:branch.id, ingredientId:it.id, quantityPurchased:it.quantity, remainingQuantity:it.quantity, unitCost:it.unitCost, totalCost:it.quantity*it.unitCost, batchId:TARGET } })
  } else {
    for (const p of it.purchases) if (p.batchId !== TARGET) { console.log(`~ move "${it.name}" purchase ${p.batchId} -> ${TARGET}`); if (COMMIT) await prisma.inventoryPurchase.update({ where:{ id:p.id }, data:{ batchId:TARGET } }) }
  }
}

// 2. Phantom purchases whose item is deleted -> soft-delete
const phantoms = await prisma.inventoryPurchase.findMany({ where:{ branchId:branch.id, deletedAt:null, ingredient:{ deletedAt:{ not:null } } }, select:{ id:true, ingredient:{ select:{ name:true } } } })
for (const p of phantoms) { console.log(`- soft-delete phantom purchase for deleted item "${p.ingredient.name}"`); if (COMMIT) await prisma.inventoryPurchase.update({ where:{ id:p.id }, data:{ deletedAt:new Date() } }) }

console.log(`\n${COMMIT?'Committed.':'Dry run — re-run with --commit.'}`)
await prisma.$disconnect()
