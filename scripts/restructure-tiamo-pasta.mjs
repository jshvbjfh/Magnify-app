/**
 * Restructure Tiamo Pasta: replace the 3 generic "Pasta + <sauce>" dishes with
 * shape-named combos (Spaghetti / Macaroni × Pomodoro / Bolognese / Mac & Cheese),
 * all 15,000 RWF. Each new dish copies the matching sauce's existing recipe
 * (pasta stays 120 g via the current inventory item). Old dishes are soft-deleted
 * so sales history is preserved. Idempotent / re-runnable.
 *
 * DRY RUN by default. Pass --commit to write.
 *   node scripts/restructure-tiamo-pasta.mjs           # preview
 *   node scripts/restructure-tiamo-pasta.mjs --commit  # apply
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

const COMMIT = process.argv.includes('--commit')
const SHAPES = ['Spaghetti', 'Macaroni']            // Tagliatelle excluded (not in stock)
const SAUCES = ['Pomodoro', 'Bolognese', 'Mac & Cheese']
const PRICE = 15000

function sauceOf(name) {
  if (/bolognese/i.test(name)) return 'Bolognese'
  if (/mac\s*&?\s*cheese/i.test(name)) return 'Mac & Cheese'
  if (/pomodoro/i.test(name)) return 'Pomodoro'
  return null
}

async function main() {
  console.log(`\n${COMMIT ? '🟢 COMMIT' : '🟡 DRY RUN'} — Tiamo Pasta restructure\n`)
  const user = await prisma.user.findUnique({ where: { email: 'high5ive@management.com' }, select: { id: true } })
  const rest = await prisma.restaurant.findFirst({ where: { ownerId: user.id }, select: { id: true } })
  const branch = await prisma.branch.findFirst({ where: { restaurantId: rest.id, name: 'Tiamo Pasta' }, select: { id: true } })
  if (!branch) throw new Error('Tiamo Pasta branch not found')

  // Source recipes: the existing generic pasta dishes, keyed by sauce.
  const oldDishes = await prisma.dish.findMany({
    where: { branchId: branch.id, deletedAt: null, name: { startsWith: 'Pasta +' } },
    select: { id: true, name: true, ingredients: { select: { inventoryItemId: true, quantityRequired: true, unit: true } } },
  })
  const recipeBySauce = {}
  for (const d of oldDishes) {
    const s = sauceOf(d.name)
    if (s) recipeBySauce[s] = d.ingredients
  }
  console.log('Source recipes found for sauces:', Object.keys(recipeBySauce).join(', ') || '(none)')
  for (const s of SAUCES) if (!recipeBySauce[s]) console.log(`  ⚠️  No source recipe for "${s}" — new ${s} dishes will be created WITHOUT a recipe`)

  // Create the shape × sauce combos.
  for (const shape of SHAPES) {
    for (const sauce of SAUCES) {
      const name = `${shape} ${sauce}`
      const existing = await prisma.dish.findFirst({ where: { branchId: branch.id, name, deletedAt: null }, select: { id: true } })
      if (existing) { console.log(`= exists, skip: ${name}`); continue }
      const ingredients = recipeBySauce[sauce] ?? []
      console.log(`+ create: ${name}  = ${PRICE}  (recipe: ${ingredients.length} items)`)
      if (COMMIT) {
        await prisma.dish.create({
          data: {
            restaurantId: rest.id, branchId: branch.id, name, category: 'Pasta',
            menuType: 'mains', sellingPrice: PRICE, isActive: true,
            ingredients: { create: ingredients.map(i => ({ inventoryItemId: i.inventoryItemId, quantityRequired: i.quantityRequired, unit: i.unit })) },
          },
        })
      }
    }
  }

  // Retire the generic dishes (soft delete).
  for (const d of oldDishes) {
    console.log(`- retire (soft-delete): ${d.name}`)
    if (COMMIT) await prisma.dish.update({ where: { id: d.id }, data: { deletedAt: new Date(), isActive: false } })
  }

  console.log(`\n${COMMIT ? 'Done — committed.' : 'Preview only. Re-run with --commit to apply.'}\n`)
}
main().catch(e => { console.error('FATAL:', e.message) }).finally(() => prisma.$disconnect())
