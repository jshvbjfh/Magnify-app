import { createRequire } from 'module'; import { resolve } from 'path'; import { readFileSync } from 'fs'
for (const f of ['.env.local','.env']) { try { for (const l of readFileSync(resolve(process.cwd(),f),'utf8').split('\n')) { const t=l.trim(); if(!t||t.startsWith('#'))continue; const e=t.indexOf('='); if(e<0)continue; const k=t.slice(0,e).trim(), v=t.slice(e+1).trim().replace(/^['"]|['"]$/g,''); if(!process.env[k])process.env[k]=v } } catch{} }
const require = createRequire(import.meta.url); const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })
const COMMIT = process.argv.includes('--commit')

const PASTA = ['Spaghetti', 'Macaroni']
const SAUCES = {
  'Pomodoro':     [['Crushed tomatoes',150,'g'],['Garlic (minced)',5,'g'],['Olive oil',20,'ml'],['Fresh basil',5,'g'],['Salt',3,'g'],['Parmesan',15,'g']],
  'Bolognese':    [['Ground beef',100,'g'],['Crushed tomatoes',120,'g'],['Onion',30,'g'],['Garlic (minced)',5,'g'],['Olive oil',15,'ml'],['Tomato paste',15,'g'],['Salt',3,'g'],['Parmesan',15,'g']],
  'Mac & Cheese': [['Cheddar / gouda',80,'g'],['Butter',15,'g'],['Fresh cream',100,'g'],['Salt',3,'g'],['Nutmeg',1,'g'],['Garlic (minced)',5,'g']],
}

async function main() {
  console.log(`\n${COMMIT?'🟢 COMMIT':'🟡 DRY RUN'} — reverse pasta combos into Pasta + Sauces components\n`)
  const user = await prisma.user.findUnique({ where:{ email:'high5ive@management.com' }, select:{ id:true } })
  const rest = await prisma.restaurant.findFirst({ where:{ ownerId:user.id }, select:{ id:true } })
  const branch = await prisma.branch.findFirst({ where:{ restaurantId:rest.id, name:'Tiamo Pasta' }, select:{ id:true } })

  // inventory item name -> id (Tiamo)
  const inv = await prisma.inventoryItem.findMany({ where:{ branchId:branch.id, deletedAt:null }, select:{ id:true, name:true } })
  const invId = Object.fromEntries(inv.map(i => [i.name, i.id]))
  const need = name => { const id = invId[name]; if (!id) console.log(`   ⚠ inventory item missing: "${name}" (recipe line skipped)`); return id }

  // Pasta items (recipe: 120g of generic "Pasta" item)
  for (const shape of PASTA) {
    const exists = await prisma.dish.findFirst({ where:{ branchId:branch.id, name:shape, deletedAt:null }, select:{ id:true } })
    if (exists) { console.log(`= Pasta "${shape}" exists — skip`); continue }
    const pastaId = need('Pasta')
    console.log(`+ Pasta dish "${shape}" = 15000 (recipe: Pasta 120 g)`)
    if (COMMIT) await prisma.dish.create({ data:{ restaurantId:rest.id, branchId:branch.id, name:shape, category:'Pasta', menuType:'mains', sellingPrice:15000, isActive:true, ingredients: pastaId ? { create:[{ inventoryItemId:pastaId, quantityRequired:120, unit:'g' }] } : undefined } })
  }

  // Sauce items (price 0, recipe = sauce ingredients)
  for (const [sauce, lines] of Object.entries(SAUCES)) {
    const exists = await prisma.dish.findFirst({ where:{ branchId:branch.id, name:sauce, deletedAt:null }, select:{ id:true } })
    if (exists) { console.log(`= Sauce "${sauce}" exists — skip`); continue }
    const ing = lines.map(([n,q,u]) => ({ inventoryItemId: need(n), quantityRequired:q, unit:u })).filter(x => x.inventoryItemId)
    console.log(`+ Sauce dish "${sauce}" = 0 (recipe: ${ing.length} items)`)
    if (COMMIT) await prisma.dish.create({ data:{ restaurantId:rest.id, branchId:branch.id, name:sauce, category:'Sauces', menuType:'sides', sellingPrice:0, isActive:true, ingredients:{ create: ing } } })
  }

  // Retire the 6 combos
  const combos = await prisma.dish.findMany({ where:{ branchId:branch.id, deletedAt:null, category:'Pasta', name:{ in: PASTA.flatMap(p => Object.keys(SAUCES).map(s => `${p} ${s}`)) } }, select:{ id:true, name:true } })
  for (const c of combos) { console.log(`- retire combo "${c.name}"`); if (COMMIT) await prisma.dish.update({ where:{ id:c.id }, data:{ deletedAt:new Date(), isActive:false } }) }

  console.log(`\n${COMMIT?'Committed.':'Dry run — re-run with --commit.'}`)
}
main().catch(e=>console.error('FATAL:',e.message)).finally(()=>prisma.$disconnect())
