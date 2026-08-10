/**
 * Little Taipei (2026-07-14), one transaction:
 *  1. Normalize meat stock to grams and fix per-kg costs entered as per-gram:
 *     - Beef (strips):        9 kg @ 9,000/kg  → 9000 g @ 9/g   (owner-confirmed price)
 *     - Chicken breast:       6 kg @ 8,000/kg  → 6000 g @ 8/g   (owner-confirmed price)
 *     - Chicken thigh (pieces): same entry error, same fix       (total cost unchanged)
 *     Purchase rows in batch B-06182026-0CD30D updated to match (bought in kg,
 *     used in g, 1 kg = 1000 g).
 *  2. Create Sizzling Wok Plate (Chicken) and (Pork) @ 16,000 — same recipe as
 *     the beef plate with the protein swapped (170 g chicken breast / ground pork).
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

const LT = 'cmqiad2vx000in5p176jvqush'

// itemId → fixed values (all usage in grams)
const FIXES = [
  { id: 'cmqjl15sg0005altlb7q8tk4a', name: 'Beef (strips)',          perKg: 9000, kgBought: 9 },
  { id: 'cmqjl16t20007altlklx9xh2v', name: 'Chicken breast',         perKg: 8000, kgBought: 6 },
  { id: 'cmqjl18j50009altlyhwuqxms', name: 'Chicken thigh (pieces)', perKg: 8000, kgBought: 6 },
]

await prisma.$transaction(async tx => {
  // 1. Stock fixes
  for (const f of FIXES) {
    const grams = f.kgBought * 1000
    const perGram = f.perKg / 1000
    await tx.inventoryItem.update({
      where: { id: f.id },
      data: { unit: 'g', quantity: grams, unitCost: perGram },
    })
    const upd = await tx.inventoryPurchase.updateMany({
      where: { ingredientId: f.id, deletedAt: null },
      data: {
        purchaseQuantity: f.kgBought,
        purchaseUnit: 'kg',
        unitsPerPurchaseUnit: 1000,
        purchaseUnitCost: f.perKg,
        quantityPurchased: grams,
        remainingQuantity: grams,
        unitCost: perGram,
        totalCost: f.kgBought * f.perKg,
      },
    })
    console.log(`Fixed ${f.name}: ${grams}g @ ${perGram}/g (${f.kgBought}kg @ ${f.perKg}/kg), ${upd.count} purchase row(s)`)
  }

  // 2. New sizzling dishes cloned from the beef plate
  const beef = await tx.dish.findFirst({
    where: { branchId: LT, name: 'Sizzling Wok Plate (Beef)', deletedAt: null },
    select: {
      restaurantId: true, category: true, menuType: true, sellingPrice: true,
      ingredients: { select: { inventoryItemId: true, quantityRequired: true, unit: true, inventoryItem: { select: { name: true } } } },
    },
  })
  if (!beef) throw new Error('Sizzling Wok Plate (Beef) not found')

  const nonProtein = beef.ingredients.filter(i => i.inventoryItem.name !== 'Beef (strips)')
  const beefQty = beef.ingredients.find(i => i.inventoryItem.name === 'Beef (strips)')?.quantityRequired ?? 170

  const PROTEINS = [
    { dishName: 'Sizzling Wok Plate (Chicken)', itemName: 'Chicken breast' },
    { dishName: 'Sizzling Wok Plate (Pork)',    itemName: 'Ground pork' },
  ]
  for (const p of PROTEINS) {
    const existing = await tx.dish.findFirst({ where: { branchId: LT, name: p.dishName } })
    if (existing) { console.log(`${p.dishName} already exists — skipped`); continue }
    const protein = await tx.inventoryItem.findFirst({
      where: { branchId: LT, name: p.itemName, deletedAt: null }, select: { id: true },
    })
    if (!protein) throw new Error(`Stock item not found: ${p.itemName}`)
    const dish = await tx.dish.create({
      data: {
        restaurantId: beef.restaurantId, branchId: LT,
        name: p.dishName, category: beef.category, menuType: beef.menuType,
        sellingPrice: beef.sellingPrice, isActive: true,
        ingredients: {
          create: [
            { inventoryItemId: protein.id, quantityRequired: beefQty, unit: 'g' },
            ...nonProtein.map(i => ({ inventoryItemId: i.inventoryItemId, quantityRequired: i.quantityRequired, unit: i.unit })),
          ],
        },
      },
    })
    console.log(`Created ${p.dishName} @ ${beef.sellingPrice} [${dish.id}] — ${beefQty}g ${p.itemName} + ${nonProtein.length} shared ingredients`)
  }
}, { timeout: 60000, maxWait: 10000 })

await prisma.$disconnect()
console.log('\nDone.')
