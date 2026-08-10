/**
 * High 5ive menu changes (2026-07-14), all in one transaction:
 *  1. Vitalo (dish + stock item + its purchase batch) moves Banana Bar → Parking Bar.
 *  2. Tiamo Pasta: every 'Pasta' dish sells at 15,000; every 'Sauces' dish is free.
 *  3. Parking Bar: wines split out of 'Alcohol' into new 'Wines'; rest renamed 'Beers'.
 *  4. THE GRILL: 'Brochettes' category merged into 'Grill'.
 *  5. New Tiamo Pasta dish 'Tagliatelli' @15,000 with a 120g recipe against a new
 *     'Tagliatelli' stock item (qty/cost 0 until purchase details arrive).
 *  6. Parking Bar 'Fanta *' dishes renamed 'Soda *' and categorised 'Soft Drinks'.
 */
import { createRequire } from 'module'
import { resolve } from 'path'
import { readFileSync } from 'fs'
for (const file of ['.env.local', '.env']) {
  try {
    for (const line of readFileSync(resolve(process.cwd(), file), 'utf8').split('\n')) {
      const t = line.trim(); if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('='); if (eq < 0) continue
      const k = t.slice(0, eq).trim(), v = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
      if (!process.env[k]) process.env[k] = v
    }
  } catch {}
}
const require = createRequire(import.meta.url)
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })

const user = await prisma.user.findUnique({ where: { email: 'high5ive@management.com' }, select: { id: true } })
const rest = await prisma.restaurant.findFirst({ where: { ownerId: user.id }, select: { id: true } })
const branches = await prisma.branch.findMany({ where: { restaurantId: rest.id }, select: { id: true, name: true } })
const byName = n => branches.find(b => b.name === n)?.id
const BANANA = byName('Banana Bar'), PARKING = byName('Parking Bar'), TIAMO = byName('Tiamo Pasta'), GRILL = byName('THE GRILL')
if (!BANANA || !PARKING || !TIAMO || !GRILL) throw new Error('Missing station: ' + JSON.stringify({ BANANA, PARKING, TIAMO, GRILL }))

const WINES = ['Prosecco', 'Red Wine (Merlot)', 'White Wine (Sauvignon)', 'Wine by the glass']

await prisma.$transaction(async tx => {
  // 1. Vitalo → Parking Bar (dish, stock item, purchase batch). Sales history
  //    keeps its own branchId, so past Banana Bar sales stay attributed there.
  const vitaloDish = await tx.dish.updateMany({
    where: { branchId: BANANA, name: 'Vitalo', deletedAt: null },
    data: { branchId: PARKING },
  })
  const vitaloItem = await tx.inventoryItem.updateMany({
    where: { branchId: BANANA, name: 'Vitalo', deletedAt: null },
    data: { branchId: PARKING },
  })
  const vitaloId = (await tx.inventoryItem.findFirst({ where: { branchId: PARKING, name: 'Vitalo' }, select: { id: true } }))?.id
  const vitaloBatches = vitaloId
    ? await tx.inventoryPurchase.updateMany({ where: { ingredientId: vitaloId }, data: { branchId: PARKING } })
    : { count: 0 }
  console.log(`1. Vitalo moved: dish=${vitaloDish.count} stockItem=${vitaloItem.count} batches=${vitaloBatches.count}`)

  // 2. Tiamo Pasta prices
  const pasta = await tx.dish.updateMany({
    where: { branchId: TIAMO, category: 'Pasta', deletedAt: null },
    data: { sellingPrice: 15000 },
  })
  const sauces = await tx.dish.updateMany({
    where: { branchId: TIAMO, category: 'Sauces', deletedAt: null },
    data: { sellingPrice: 0 },
  })
  console.log(`2. Tiamo Pasta: ${pasta.count} pasta dishes → 15,000; ${sauces.count} sauces → free`)

  // 3. Wines out of Alcohol, then Alcohol → Beers
  const wines = await tx.dish.updateMany({
    where: { branchId: PARKING, category: 'Alcohol', name: { in: WINES }, deletedAt: null },
    data: { category: 'Wines' },
  })
  const beers = await tx.dish.updateMany({
    where: { branchId: PARKING, category: 'Alcohol', deletedAt: null },
    data: { category: 'Beers' },
  })
  console.log(`3. Parking Bar: ${wines.count} dishes → Wines; ${beers.count} dishes → Beers`)

  // 4. Brochettes → Grill
  const broch = await tx.dish.updateMany({
    where: { branchId: GRILL, category: 'Brochettes', deletedAt: null },
    data: { category: 'Grill' },
  })
  console.log(`4. THE GRILL: ${broch.count} brochette dishes → Grill`)

  // 5. Tagliatelli — stock item (explicitly requested; qty/cost 0 until the
  //    purchase details arrive) + dish + 120g recipe. Skipped if already there.
  const existingDish = await tx.dish.findFirst({ where: { branchId: TIAMO, name: 'Tagliatelli' } })
  if (existingDish) {
    console.log('5. Tagliatelli already exists — skipped')
  } else {
    const menuType = (await tx.dish.findFirst({ where: { branchId: TIAMO, category: 'Pasta' }, select: { menuType: true } }))?.menuType ?? null
    const tagItem = await tx.inventoryItem.create({
      data: {
        restaurantId: rest.id, branchId: TIAMO, name: 'Tagliatelli',
        unit: 'g', unitCost: 0, quantity: 0, type: 'purchased', category: 'Pasta',
        description: 'Cost & opening stock pending — to be updated on purchase entry',
      },
    })
    const tagDish = await tx.dish.create({
      data: {
        restaurantId: rest.id, branchId: TIAMO, name: 'Tagliatelli',
        category: 'Pasta', menuType, sellingPrice: 15000, isActive: true,
        ingredients: { create: { inventoryItemId: tagItem.id, quantityRequired: 120, unit: 'g' } },
      },
    })
    console.log(`5. Tagliatelli created: dish=${tagDish.id} stockItem=${tagItem.id} (120g/serving, cost pending)`)
  }

  // 6. Fanta → Soda (keep the flavour), under Soft Drinks
  const fantas = await tx.dish.findMany({
    where: { branchId: PARKING, name: { startsWith: 'Fanta' }, deletedAt: null },
    select: { id: true, name: true },
  })
  for (const f of fantas) {
    await tx.dish.update({
      where: { id: f.id },
      data: { name: f.name.replace(/^Fanta/, 'Soda'), category: 'Soft Drinks' },
    })
  }
  console.log(`6. Renamed under Soft Drinks: ${fantas.map(f => `${f.name} → ${f.name.replace(/^Fanta/, 'Soda')}`).join(', ') || 'none'}`)
}, { timeout: 60000, maxWait: 10000 })

await prisma.$disconnect()
console.log('\nAll changes applied.')
