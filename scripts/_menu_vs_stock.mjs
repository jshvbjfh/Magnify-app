/** Compare every branch's menu dishes against their inventory stock. */
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
const branches = await prisma.branch.findMany({
  where: { restaurantId: rest.id },
  select: { id: true, name: true, type: true },
  orderBy: { name: 'asc' }
})

for (const b of branches) {
  if (b.name === 'Main') continue

  const dishes = await prisma.dish.findMany({
    where: { branchId: b.id, deletedAt: null },
    select: {
      name: true, category: true, sellingPrice: true,
      ingredients: {
        select: {
          quantityRequired: true, unit: true,
          inventoryItem: { select: { id: true, name: true, unit: true, quantity: true } }
        }
      }
    },
    orderBy: [{ category: 'asc' }, { name: 'asc' }]
  })

  const noRecipe = dishes.filter(d => d.ingredients.length === 0)
  const withRecipe = dishes.filter(d => d.ingredients.length > 0)
  const okDishes = withRecipe.filter(d => d.ingredients.every(i => (i.inventoryItem?.quantity ?? 0) > 0))
  const partialDishes = withRecipe.filter(d =>
    d.ingredients.some(i => (i.inventoryItem?.quantity ?? 0) > 0) &&
    d.ingredients.some(i => (i.inventoryItem?.quantity ?? 0) === 0)
  )
  const zeroDishes = withRecipe.filter(d => d.ingredients.every(i => (i.inventoryItem?.quantity ?? 0) === 0))

  console.log(`\n${'='.repeat(60)}`)
  console.log(`${b.name} [${b.type}] — ${dishes.length} dishes`)
  console.log(`  ${noRecipe.length} no recipe | ${withRecipe.length} have recipe → ${okDishes.length} fully stocked | ${partialDishes.length} partial | ${zeroDishes.length} all-zero`)

  if (noRecipe.length) {
    console.log(`\n  ⚠ NO RECIPE (stock not tracked):`)
    for (const d of noRecipe) console.log(`      ${d.name}  ${d.sellingPrice} RWF`)
  }

  if (zeroDishes.length) {
    console.log(`\n  ❌ RECIPE EXISTS BUT ALL INGREDIENTS AT ZERO STOCK:`)
    for (const d of zeroDishes) {
      console.log(`      ${d.name}  ${d.sellingPrice} RWF`)
      for (const i of d.ingredients) {
        const inv = i.inventoryItem
        console.log(`          - ${inv?.name ?? '?'} needs ${i.quantityRequired}${i.unit ?? ''} | stock: ${inv?.quantity ?? '?'} ${inv?.unit ?? ''}`)
      }
    }
  }

  if (partialDishes.length) {
    console.log(`\n  ⚡ PARTIAL STOCK (some ingredients stocked, some zero):`)
    for (const d of partialDishes) {
      console.log(`      ${d.name}  ${d.sellingPrice} RWF`)
      for (const i of d.ingredients) {
        const inv = i.inventoryItem
        const stocked = (inv?.quantity ?? 0) > 0
        console.log(`          ${stocked ? '✓' : '✗'} ${inv?.name ?? '?'} needs ${i.quantityRequired}${i.unit ?? ''} | stock: ${inv?.quantity ?? '?'} ${inv?.unit ?? ''}`)
      }
    }
  }

  if (okDishes.length) {
    console.log(`\n  ✅ FULLY STOCKED:`)
    for (const d of okDishes) console.log(`      ${d.name}  ${d.sellingPrice} RWF`)
  }
}

await prisma.$disconnect()
