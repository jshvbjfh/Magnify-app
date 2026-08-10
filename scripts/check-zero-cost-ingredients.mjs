/**
 * READ-ONLY: For High 5ive, lists every dish-ingredient with unitCost = 0
 * and shows ALL purchase records for it (across all branches) so we can
 * confirm whether real costs exist anywhere.
 * Run: node scripts/check-zero-cost-ingredients.mjs
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
const EMAIL = 'high5ive@management.com'
const EPSILON = 0.000001

async function main() {
  const user = await prisma.user.findUnique({ where: { email: EMAIL }, select: { id: true } })
  if (!user) { console.log(`No user found for ${EMAIL}`); return }

  const restaurants = await prisma.restaurant.findMany({ where: { ownerId: user.id }, select: { id: true, name: true } })

  for (const rest of restaurants) {
    console.log(`\nRestaurant: ${rest.name}`)

    // Get all unique inventory items used in dish recipes with unitCost = 0
    const zeroItems = await prisma.inventoryItem.findMany({
      where: {
        restaurantId: rest.id,
        unitCost: { lte: EPSILON },
        dishIngredients: { some: {} },
      },
      select: {
        id: true, name: true, unit: true, unitCost: true, quantity: true,
        branch: { select: { name: true } },
      },
      orderBy: [{ branch: { name: 'asc' } }, { name: 'asc' }],
    })

    if (!zeroItems.length) {
      console.log('  ✅ All dish ingredients have unitCost > 0')
      continue
    }

    console.log(`  ⚠ ${zeroItems.length} inventory items in recipes with unitCost = 0:\n`)

    for (const item of zeroItems) {
      // All purchases for this item (restaurant-wide)
      const purchases = await prisma.inventoryPurchase.findMany({
        where: { ingredientId: item.id },
        select: {
          id: true,
          unitCost: true,
          quantityPurchased: true,
          remainingQuantity: true,
          purchasedAt: true,
          branch: { select: { name: true } },
        },
        orderBy: [{ purchasedAt: 'desc' }],
      })

      const withRealCost = purchases.filter(p => (p.unitCost ?? 0) > EPSILON)

      console.log(`  📦 ${item.name}  [${item.branch.name}]  stock: ${item.quantity} ${item.unit}`)

      if (!purchases.length) {
        console.log(`      → NO purchase records at all`)
      } else {
        for (const p of purchases) {
          const flag = (p.unitCost ?? 0) > EPSILON ? '✅' : '❌'
          console.log(`      ${flag} ${p.branch.name}  ${new Date(p.purchasedAt).toLocaleDateString()}  qty:${p.quantityPurchased}${item.unit}  unitCost:${p.unitCost} RWF  remaining:${p.remainingQuantity}`)
        }
        if (withRealCost.length) {
          console.log(`      → CAN fix: use ${withRealCost[0].unitCost} RWF/${item.unit} from purchase on ${new Date(withRealCost[0].purchasedAt).toLocaleDateString()}`)
        } else {
          console.log(`      → All purchases have unitCost = 0 — need manual cost entry`)
        }
      }
      console.log()
    }
  }
}

main().catch(e => { console.error('FATAL:', e.message) }).finally(() => prisma.$disconnect())
