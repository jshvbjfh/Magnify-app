/** READ-ONLY: look for Sizzling dishes + pork/chicken/beef stock, and list
 *  dishes with no recipe, across all High 5ive stations. */
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

// 1. Sizzling dishes anywhere
const sizzling = await prisma.dish.findMany({
  where: { restaurantId: rest.id, name: { contains: 'izzl' } },
  select: {
    id: true, name: true, category: true, sellingPrice: true, deletedAt: true, isActive: true,
    branch: { select: { name: true } },
    ingredients: { select: { quantityRequired: true, inventoryItem: { select: { name: true, unit: true, unitCost: true, quantity: true } } } },
  },
})
console.log('=== Sizzling dishes ===')
if (!sizzling.length) console.log('  (none found)')
for (const d of sizzling) {
  console.log(`  ${d.branch.name} | ${d.category ?? '-'} | ${d.name} @ ${d.sellingPrice}${d.deletedAt ? ' [DELETED]' : ''}${d.isActive ? '' : ' [INACTIVE]'}`)
  if (!d.ingredients.length) console.log('     ⚠ NO INGREDIENTS LINKED')
  for (const i of d.ingredients) console.log(`     - ${i.inventoryItem.name}: ${i.quantityRequired}${i.inventoryItem.unit} @ ${i.inventoryItem.unitCost} (stock: ${i.inventoryItem.quantity})`)
}

// 2. Pork/chicken/beef inventory items per station
const meat = await prisma.inventoryItem.findMany({
  where: { restaurantId: rest.id, deletedAt: null, OR: ['pork', 'chicken', 'beef'].map(m => ({ name: { contains: m, mode: 'insensitive' } })) },
  select: { name: true, unit: true, quantity: true, unitCost: true, branch: { select: { name: true } } },
  orderBy: [{ branchId: 'asc' }, { name: 'asc' }],
})
console.log('\n=== Pork/Chicken/Beef stock items ===')
for (const m of meat) console.log(`  ${m.branch.name}: ${m.name} — ${m.quantity}${m.unit} @ ${m.unitCost}`)

// 3. Dishes with no recipe at all (missing ingredients), grouped by station
const noRecipe = await prisma.dish.findMany({
  where: { restaurantId: rest.id, deletedAt: null, isActive: true, ingredients: { none: {} } },
  select: { name: true, category: true, sellingPrice: true, branch: { select: { name: true } } },
  orderBy: [{ branchId: 'asc' }, { category: 'asc' }, { name: 'asc' }],
})
console.log(`\n=== Active dishes with NO ingredients linked (${noRecipe.length}) ===`)
let st = null
for (const d of noRecipe) {
  if (d.branch.name !== st) { st = d.branch.name; console.log(`  ── ${st} ──`) }
  console.log(`    ${d.category ?? '-'} | ${d.name} @ ${d.sellingPrice}`)
}

await prisma.$disconnect()
