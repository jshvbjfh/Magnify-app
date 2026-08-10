/**
 * Fix dish ingredients where inventoryItem.unitCost = 0 by syncing from purchase history.
 * Only updates existing InventoryItem records — never creates new ones.
 * Run: node scripts/fix-ingredient-costs.mjs
 * Add --dry-run to preview without writing.
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
const DRY_RUN = process.argv.includes('--dry-run')
const EMAIL = 'high5ive@management.com'
const EPSILON = 0.000001

async function main() {
  const user = await prisma.user.findUnique({ where: { email: EMAIL }, select: { id: true } })
  if (!user) { console.log(`No user found for ${EMAIL}`); return }

  const restaurants = await prisma.restaurant.findMany({ where: { ownerId: user.id }, select: { id: true, name: true } })
  console.log(`Account: ${EMAIL}`)
  console.log(`Restaurants: ${restaurants.map(r => r.name).join(', ')}`)
  if (DRY_RUN) console.log('DRY RUN — no changes will be written\n')

  let totalFixed = 0
  let totalMissing = 0
  let totalOk = 0

  for (const rest of restaurants) {
    const branches = await prisma.branch.findMany({
      where: { restaurantId: rest.id },
      select: { id: true, name: true, type: true },
      orderBy: { name: 'asc' },
    })

    for (const b of branches) {
      // All dish ingredients in this branch
      const dishIngredients = await prisma.dishIngredient.findMany({
        where: { dish: { branchId: b.id, deletedAt: null } },
        select: {
          quantityRequired: true,
          inventoryItem: {
            select: { id: true, name: true, unit: true, unitCost: true, quantity: true },
          },
          dish: { select: { name: true } },
        },
      })

      // Deduplicate by inventoryItem.id
      const seen = new Map()
      for (const di of dishIngredients) {
        const item = di.inventoryItem
        if (!seen.has(item.id)) {
          seen.set(item.id, { item, usedInDishes: [] })
        }
        seen.get(item.id).usedInDishes.push(`${di.dish.name} (${di.quantityRequired}${item.unit})`)
      }

      const zeroCostItems = [...seen.values()].filter(({ item }) => (item.unitCost ?? 0) < EPSILON)
      const okItems = [...seen.values()].filter(({ item }) => (item.unitCost ?? 0) >= EPSILON)
      totalOk += okItems.length

      if (seen.size === 0) continue

      console.log(`\n${'─'.repeat(60)}`)
      console.log(`${rest.name} / ${b.name} [${b.type}] — ${seen.size} unique ingredients in recipes`)

      // Show OK items
      if (okItems.length) {
        console.log(`\n  ✅ HAS COST (${okItems.length}):`)
        for (const { item, usedInDishes } of okItems) {
          console.log(`     ${item.name}  ${item.unitCost.toLocaleString()} RWF/${item.unit}`)
          for (const d of usedInDishes) console.log(`        used in: ${d}`)
        }
      }

      if (!zeroCostItems.length) continue

      console.log(`\n  ⚠ ZERO COST (${zeroCostItems.length}) — checking purchase history:`)

      for (const { item, usedInDishes } of zeroCostItems) {
        // Find best purchase: prefer last purchase with unitCost > 0
        const purchases = await prisma.inventoryPurchase.findMany({
          where: { ingredientId: item.id, branchId: b.id },
          select: { id: true, unitCost: true, quantityPurchased: true, remainingQuantity: true, purchasedAt: true },
          orderBy: [{ purchasedAt: 'desc' }, { createdAt: 'desc' }],
        })

        const withCost = purchases.filter(p => (p.unitCost ?? 0) > EPSILON)
        const bestCost = withCost.length ? withCost[0].unitCost : null

        console.log(`\n     ${item.name}  (stock: ${item.quantity} ${item.unit})`)
        for (const d of usedInDishes) console.log(`        used in: ${d}`)

        if (!purchases.length) {
          console.log(`        ❌ NO purchase records — cannot determine cost`)
          totalMissing++
          continue
        }

        if (!bestCost) {
          console.log(`        ❌ ${purchases.length} purchase(s) all have unitCost = 0 — cannot fix`)
          totalMissing++
          continue
        }

        console.log(`        📦 ${purchases.length} purchase(s), last with cost: ${bestCost.toLocaleString()} RWF/${item.unit}`)
        console.log(`        ${DRY_RUN ? '[DRY RUN]' : '→'} Setting unitCost = ${bestCost.toLocaleString()} RWF/${item.unit}`)

        if (!DRY_RUN) {
          await prisma.inventoryItem.update({
            where: { id: item.id },
            data: { unitCost: bestCost },
          })
        }
        totalFixed++
      }
    }
  }

  console.log(`\n${'═'.repeat(60)}`)
  console.log(`SUMMARY`)
  console.log(`  Already had cost : ${totalOk}`)
  console.log(`  Fixed (or would) : ${totalFixed}`)
  console.log(`  No cost data     : ${totalMissing}`)
  if (DRY_RUN) console.log('\nRe-run without --dry-run to apply fixes.')
}

main().catch(e => { console.error('FATAL:', e.message) }).finally(() => prisma.$disconnect())
