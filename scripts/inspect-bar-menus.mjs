/**
 * READ-ONLY: Show all dishes + ingredients for Banana Bar and Parking Bar (High 5ive)
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
const rest = await prisma.restaurant.findFirst({ where: { ownerId: user.id }, select: { id: true, name: true } })
const branches = await prisma.branch.findMany({
  where: { restaurantId: rest.id, type: 'bar' },
  select: { id: true, name: true },
  orderBy: { name: 'asc' },
})

for (const b of branches) {
  const dishes = await prisma.dish.findMany({
    where: { branchId: b.id, deletedAt: null },
    select: {
      id: true, name: true, category: true, sellingPrice: true, menuType: true, isActive: true,
      ingredients: {
        select: {
          quantityRequired: true,
          inventoryItem: { select: { name: true, unit: true, unitCost: true } },
        },
      },
      variants: { where: { deletedAt: null }, select: { name: true, sellingPrice: true } },
    },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
  })

  console.log(`\n${'═'.repeat(60)}`)
  console.log(`${b.name} [${b.id}] — ${dishes.length} dishes`)

  let cat = null
  for (const d of dishes) {
    if (d.category !== cat) { cat = d.category; console.log(`\n  ── ${cat ?? 'Uncategorised'} ──`) }
    const v = d.variants.length ? `  [${d.variants.map(x => `${x.name}:${x.sellingPrice}`).join(' | ')}]` : ''
    console.log(`  ${d.isActive ? '' : '[INACTIVE] '}${d.name}  ${d.sellingPrice} RWF${v}`)
    if (d.ingredients.length === 0) {
      console.log(`      ⚠ no ingredients linked`)
    } else {
      for (const i of d.ingredients) {
        const cost = i.inventoryItem.unitCost ?? 0
        console.log(`      ${cost > 0 ? '✅' : '❌'} ${i.inventoryItem.name}  ${i.quantityRequired}${i.inventoryItem.unit}  @ ${cost} RWF`)
      }
    }
  }
}

await prisma.$disconnect()
