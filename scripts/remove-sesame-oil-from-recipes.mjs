/**
 * High 5ive (2026-07-14): kitchens no longer use sesame oil — remove it from
 * every dish recipe (the stock item itself stays, just unused).
 * Also verify the Tagliatelli stock item + dish link in Tiamo Pasta.
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

// Every recipe line pointing at a sesame-oil stock item in this restaurant
const links = await prisma.dishIngredient.findMany({
  where: {
    inventoryItem: { restaurantId: rest.id, name: { contains: 'esame oil' } },
    dish: { restaurantId: rest.id },
  },
  select: {
    id: true,
    dish: { select: { name: true, branch: { select: { name: true } } } },
    inventoryItem: { select: { name: true } },
  },
})
console.log(`Sesame oil found in ${links.length} recipes:`)
for (const l of links) console.log(`  - ${l.dish.branch.name} | ${l.dish.name} (${l.inventoryItem.name})`)

if (links.length) {
  const del = await prisma.dishIngredient.deleteMany({ where: { id: { in: links.map(l => l.id) } } })
  console.log(`Removed ${del.count} recipe lines.`)
}

// Tagliatelli status in Tiamo Pasta
const tagItem = await prisma.inventoryItem.findFirst({
  where: { restaurantId: rest.id, name: 'Tagliatelli' },
  select: { id: true, unit: true, quantity: true, unitCost: true, branch: { select: { name: true } }, _count: { select: { purchases: true, dishIngredients: true } } },
})
console.log('\nTagliatelli stock item:', JSON.stringify(tagItem))

await prisma.$disconnect()
