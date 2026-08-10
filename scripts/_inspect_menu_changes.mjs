/**
 * READ-ONLY: Snapshot of the stations/categories touched by the 2026-07-14
 * menu changes (Banana Bar soft drinks, Tiamo Pasta prices, Parking Bar
 * Alcohol/Fanta, Grill Brochettes) for high5ive@management.com.
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
console.log(`Restaurant: ${rest.name} [${rest.id}]`)

const branches = await prisma.branch.findMany({
  where: { restaurantId: rest.id },
  select: { id: true, name: true, type: true },
  orderBy: { name: 'asc' },
})
console.log('\nStations:')
for (const b of branches) console.log(`  ${b.name} (${b.type}) [${b.id}]`)

const interesting = branches.filter(b => /banana|parking|tiamo|grill/i.test(b.name))
for (const b of interesting) {
  const dishes = await prisma.dish.findMany({
    where: { branchId: b.id, deletedAt: null },
    select: { id: true, name: true, category: true, sellingPrice: true, isActive: true },
    orderBy: [{ category: 'asc' }, { name: 'asc' }],
  })
  console.log(`\n${'═'.repeat(60)}\n${b.name} — ${dishes.length} dishes`)
  let cat = null
  for (const d of dishes) {
    if (d.category !== cat) { cat = d.category; console.log(`  ── ${cat ?? '(no category)'} ──`) }
    console.log(`    ${d.isActive ? '' : '[INACTIVE] '}${d.name}  ${d.sellingPrice}`)
  }
}

// Existing Tagliatelli traces anywhere (dish or inventory) to avoid duplicates.
const tagDish = await prisma.dish.findMany({
  where: { restaurantId: rest.id, name: { contains: 'agliatell' } },
  select: { id: true, name: true, branchId: true, deletedAt: true },
})
const tagInv = await prisma.inventoryItem.findMany({
  where: { restaurantId: rest.id, name: { contains: 'agliatell' } },
  select: { id: true, name: true, branchId: true, unit: true, quantity: true, deletedAt: true },
})
console.log('\nTagliatelli dishes:', JSON.stringify(tagDish))
console.log('Tagliatelli inventory:', JSON.stringify(tagInv))

await prisma.$disconnect()
