import { createRequire } from 'module'; import { resolve } from 'path'; import { readFileSync } from 'fs'
for (const f of ['.env.local','.env']) { try { for (const l of readFileSync(resolve(process.cwd(),f),'utf8').split('\n')) { const t=l.trim(); if(!t||t.startsWith('#'))continue; const e=t.indexOf('='); if(e<0)continue; const k=t.slice(0,e).trim(), v=t.slice(e+1).trim().replace(/^['"]|['"]$/g,''); if(!process.env[k])process.env[k]=v } } catch{} }
const require = createRequire(import.meta.url); const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })
const COMMIT = process.argv.includes('--commit')

// [name, category, price, description]
const ITEMS = [
  // Alcohol
  ['Heineken','Alcohol',3500,''],['Virunga','Alcohol',3500,''],['Skoll Malt','Alcohol',3500,''],
  ['Amstel','Alcohol',4000,''],['Mutzig','Alcohol',3000,''],['Skoll Lager','Alcohol',5000,''],
  ['Desperado','Alcohol',5000,''],['Red Wine (Merlot)','Alcohol',36000,''],['White Wine (Sauvignon)','Alcohol',38000,''],
  ['Wine by the glass','Alcohol',9000,''],['Prosecco','Alcohol',48000,''],
  // Soft drinks
  ['Coke','Soft Drinks',2500,''],['Fanta','Soft Drinks',2500,''],['Sprite','Soft Drinks',2500,''],['Tonic','Soft Drinks',2500,''],
  ['Fresh Juice','Soft Drinks',7000,'On availability'],['Panache','Soft Drinks',2500,''],['Water','Soft Drinks',2000,'Sparkling or still'],
  // Mocktails 9000
  ['Virgin Mojito','Mocktails',9000,'Mint, lime, sugar, soda water'],
  ['Mango Lemonade','Mocktails',9000,'Mango, lemon juice, soda water'],
  ['Blue Candy','Mocktails',9000,'Orange juice, grenadine, blue curaçao'],
  ['Virgin Piña Colada','Mocktails',9000,'Pineapple juice, coconut cream'],
  ['Tropical Sunset','Mocktails',9000,'Orange juice, pineapple juice, grenadine'],
  ['Melon Splash','Mocktails',9000,'Watermelon juice, lime, mint, soda water'],
  // Smoothies & Shakes 8000
  ['Healing','Smoothies & Shakes',8000,'Pineapple, ginger, lemon'],
  ['Detox 5','Smoothies & Shakes',8000,'Cucumber, apple, mint, pineapple'],
  ['High 5 Joy','Smoothies & Shakes',8000,'Apple, pineapple, mango'],
  ['Proteine Shake','Smoothies & Shakes',8000,'Peanut butter, milk, cocoa, banana'],
  ['Urukundo Shake','Smoothies & Shakes',8000,'Vanilla ice cream, milk, strawberry'],
  ['Chocolate Shake','Smoothies & Shakes',8000,'Chocolate ice cream, milk, chocolate syrup'],
  // Hot Beverages
  ['Black coffee','Hot Beverages',4000,''],['Expresso','Hot Beverages',4000,''],['Americano','Hot Beverages',5000,''],
  ['Cappuccino','Hot Beverages',5000,''],['Latte Macchiato','Hot Beverages',5000,''],['Coffee & milk','Hot Beverages',5000,''],
  ['Café Latte','Hot Beverages',5000,''],['African tea','Hot Beverages',5000,'Milk, ginger, tea masala'],
  ['Spice tea','Hot Beverages',5000,'Lemon, ginger, honey'],['Green tea','Hot Beverages',3000,''],
  ['Fresh Mint tea','Hot Beverages',5000,''],['Black tea','Hot Beverages',3000,''],
  ['Hot chocolate','Hot Beverages',5000,''],['Hot Milk','Hot Beverages',2500,''],
]

async function main() {
  console.log(`\n${COMMIT?'🟢 COMMIT':'🟡 DRY RUN'} — add Parking Bar drinks (${ITEMS.length})\n`)
  const user = await prisma.user.findUnique({ where:{ email:'high5ive@management.com' }, select:{ id:true } })
  const rest = await prisma.restaurant.findFirst({ where:{ ownerId:user.id }, select:{ id:true } })
  const branch = await prisma.branch.findFirst({ where:{ restaurantId:rest.id, name:'Parking Bar' }, select:{ id:true } })
  if (!branch) { console.log('Parking Bar branch not found'); return }
  let added = 0
  for (const [name, category, price, desc] of ITEMS) {
    const exists = await prisma.dish.findFirst({ where:{ branchId:branch.id, name, deletedAt:null }, select:{ id:true } })
    if (exists) { console.log(`= exists: ${name}`); continue }
    added++
    if (COMMIT) await prisma.dish.create({ data:{ restaurantId:rest.id, branchId:branch.id, name, category, menuType:'drink', sellingPrice:price, description:desc||null, isActive:true } })
  }
  const byCat = {}; for (const [,c] of ITEMS) byCat[c]=(byCat[c]||0)+1
  for (const [c,n] of Object.entries(byCat)) console.log(`  ${c}: ${n}`)
  console.log(`\n${added} to add. ${COMMIT?'Committed.':'Dry run — re-run with --commit.'}`)
}
main().catch(e=>console.error('FATAL:',e.message)).finally(()=>prisma.$disconnect())
