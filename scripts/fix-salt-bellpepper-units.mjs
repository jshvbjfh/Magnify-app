/**
 * High 5ive (2026-07-14): kg/g unit fixes.
 *  1. Tiamo Pasta Salt — item tracked in kg while recipes dose grams; recipe
 *     lines saying "2kg salt" drained the owner's 2kg entry on first sales.
 *     → item to grams (2000g @ 2/g, restoring the stock the owner entered),
 *       purchase row to bought-2kg/used-in-g, every salt recipe line to grams.
 *  2. Little Taipei Bell pepper (mixed) — item in kg, recipes in g, making the
 *     menu cost estimate read 60 kg (120,000 RWF) instead of 60 g (120 RWF).
 *     → item to grams (2000g @ 2/g) + purchase row to match. Total costs unchanged.
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

const TIAMO = 'cmqiadl7h000nn5p1trr8hdcc'
const LT = 'cmqiad2vx000in5p176jvqush'

await prisma.$transaction(async tx => {
  // ── 1. Tiamo Salt ──
  const salt = await tx.inventoryItem.findFirst({
    where: { branchId: TIAMO, name: 'Salt', deletedAt: null }, select: { id: true },
  })
  if (!salt) throw new Error('Tiamo Salt not found')
  await tx.inventoryItem.update({
    where: { id: salt.id },
    data: { unit: 'g', quantity: 2000, unitCost: 2 },
  })
  await tx.inventoryPurchase.updateMany({
    where: { ingredientId: salt.id, deletedAt: null },
    data: {
      purchaseQuantity: 2, purchaseUnit: 'kg', unitsPerPurchaseUnit: 1000, purchaseUnitCost: 2000,
      quantityPurchased: 2000, remainingQuantity: 2000, unitCost: 2, totalCost: 4000,
    },
  })
  // Every salt recipe line becomes grams. Lines that said "2 kg" were data
  // errors for a 2 g pinch — the number stays, only the unit meaning changes.
  const saltLines = await tx.dishIngredient.updateMany({
    where: { inventoryItemId: salt.id },
    data: { unit: 'g' },
  })
  console.log(`Salt (Tiamo): 2000g @ 2/g restored; ${saltLines.count} recipe lines set to grams`)

  // ── 2. Little Taipei Bell pepper (mixed) ──
  const pepper = await tx.inventoryItem.findFirst({
    where: { branchId: LT, name: 'Bell pepper (mixed)', deletedAt: null }, select: { id: true },
  })
  if (!pepper) throw new Error('Bell pepper (mixed) not found')
  await tx.inventoryItem.update({
    where: { id: pepper.id },
    data: { unit: 'g', quantity: 2000, unitCost: 2 },
  })
  await tx.inventoryPurchase.updateMany({
    where: { ingredientId: pepper.id, deletedAt: null },
    data: {
      purchaseQuantity: 2, purchaseUnit: 'kg', unitsPerPurchaseUnit: 1000, purchaseUnitCost: 2000,
      quantityPurchased: 2000, remainingQuantity: 2000, unitCost: 2, totalCost: 4000,
    },
  })
  console.log('Bell pepper (mixed) (Little Taipei): 2000g @ 2/g — 60g/plate now costs 120 RWF')
}, { timeout: 60000, maxWait: 10000 })

await prisma.$disconnect()
console.log('Done.')
