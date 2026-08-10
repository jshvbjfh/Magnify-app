/** READ-ONLY: full detail of Tiamo Pasta dishes (description, variants, recipe). */
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

async function main() {
  const user = await prisma.user.findUnique({ where: { email: 'high5ive@management.com' }, select: { id: true } })
  const rest = await prisma.restaurant.findFirst({ where: { ownerId: user.id }, select: { id: true } })
  const branch = await prisma.branch.findFirst({ where: { restaurantId: rest.id, name: 'Tiamo Pasta' }, select: { id: true, name: true } })
  const dishes = await prisma.dish.findMany({
    where: { branchId: branch.id, deletedAt: null },
    select: {
      id: true, name: true, category: true, menuType: true, sellingPrice: true, description: true,
      variants: { where: { deletedAt: null }, select: { name: true, sellingPrice: true } },
      ingredients: { select: { quantityRequired: true, unit: true, inventoryItem: { select: { name: true, unit: true } } } },
    },
    orderBy: { name: 'asc' },
  })
  console.log(`Branch: ${branch.name}\n`)
  for (const d of dishes) {
    console.log(`• ${d.name}  =${d.sellingPrice} (${d.menuType ?? '?'}, cat=${d.category ?? '-'})`)
    console.log(`    description: ${d.description ? JSON.stringify(d.description) : '(none)'}`)
    console.log(`    variants: ${d.variants.length ? d.variants.map(v => `${v.name} ${v.sellingPrice}`).join(', ') : '(none)'}`)
    if (d.ingredients.length) {
      console.log('    recipe:')
      for (const ing of d.ingredients) console.log(`      - ${ing.inventoryItem?.name ?? '?'} × ${ing.quantityRequired} ${ing.unit ?? ing.inventoryItem?.unit ?? ''}`)
    } else {
      console.log('    recipe: (none)')
    }
  }
}
main().catch(e => console.error('FATAL:', e.message)).finally(() => prisma.$disconnect())
