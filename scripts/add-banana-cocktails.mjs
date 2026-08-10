import { createRequire } from 'module'; import { resolve } from 'path'; import { readFileSync } from 'fs'
for (const f of ['.env.local','.env']) { try { for (const l of readFileSync(resolve(process.cwd(),f),'utf8').split('\n')) { const t=l.trim(); if(!t||t.startsWith('#'))continue; const e=t.indexOf('='); if(e<0)continue; const k=t.slice(0,e).trim(), v=t.slice(e+1).trim().replace(/^['"]|['"]$/g,''); if(!process.env[k])process.env[k]=v } } catch{} }
const require = createRequire(import.meta.url); const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })
const COMMIT = process.argv.includes('--commit')

const COCKTAILS = [
  ['Bisoke Mojito',15000,'Rum infused with fresh lime, mint and sugar'],
  ['Passion Mojito',15000,'Rum infused with fresh passion fruit, mint and lime'],
  ['High5 Basil Smash',15000,'Herbaceous flavors of basil and lemon, made with Gin'],
  ['Banana Bar Special',18000,'A bold spirited blend of Gin, Rum, Tequila, mellowed with smooth Monin tea'],
  ['Strawberry Colada',15000,'Tropical blend of strawberries, pineapple and coconut cream with Rum'],
  ['Strawberry Margarita',15000,'A refreshing blend of strawberries and lime, made with Tequila and triple sec'],
  ['High5 Red Lipstick',15000,'Exotic hibiscus and spiced cinnamon blended seamlessly with rum'],
  ['High5 Passion Rita',15000,'A reimagined twist of tequila, passion fruit and a splash of vanilla'],
  ['Bold & Bitter',15000,'A timeless blend of Gin, Campari and sweet vermouth'],
  ['Hibiscus Velvet',15000,'A tropical, vibrant blend of rum, pineapple juice, hibiscus syrup and lime'],
  ['The Revival',15000,'Whiskey, bitters and a hint of sweetness'],
  ['City Slicker',15000,'A bold, refined mix of smooth whiskey, sweet vermouth and a splash of bitters'],
  ['Salsa Sunrise',18000,'Vibrant Tequila with orange juice and grenadine — colorful and refreshing'],
  ['Sweet Surrender',15000,'A simple, perfect balance of rum, lime and sugar'],
]

async function main() {
  console.log(`\n${COMMIT?'🟢 COMMIT':'🟡 DRY RUN'} — add Banana Bar cocktails\n`)
  const user = await prisma.user.findUnique({ where:{ email:'high5ive@management.com' }, select:{ id:true } })
  const rest = await prisma.restaurant.findFirst({ where:{ ownerId:user.id }, select:{ id:true } })
  const branch = await prisma.branch.findFirst({ where:{ restaurantId:rest.id, name:'Banana Bar' }, select:{ id:true, name:true } })
  if (!branch) { console.log('Banana Bar branch not found'); return }
  let added = 0
  for (const [name, price, desc] of COCKTAILS) {
    const exists = await prisma.dish.findFirst({ where:{ branchId:branch.id, name, deletedAt:null }, select:{ id:true } })
    if (exists) { console.log(`= exists: ${name}`); continue }
    console.log(`+ ${name} = ${price}`)
    added++
    if (COMMIT) await prisma.dish.create({ data:{ restaurantId:rest.id, branchId:branch.id, name, category:'Cocktails', menuType:'drink', sellingPrice:price, description:desc, isActive:true } })
  }
  console.log(`\n${added} to add. ${COMMIT?'Committed.':'Dry run — re-run with --commit.'}`)
}
main().catch(e=>console.error('FATAL:',e.message)).finally(()=>prisma.$disconnect())
