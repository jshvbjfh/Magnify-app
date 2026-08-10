/**
 * READ-ONLY inspection of High 5ive's menu.
 * Lists restaurant, branches, and every dish (name, category, type, price, variants).
 * Run: node scripts/inspect-highfive-menu.mjs
 */
import { createRequire } from 'module'
import { resolve } from 'path'
import { readFileSync } from 'fs'

for (const file of ['.env.local', '.env']) {
  try {
    for (const line of readFileSync(resolve(process.cwd(), file), 'utf8').split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq < 0) continue
      const k = t.slice(0, eq).trim()
      const v = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
      if (!process.env[k]) process.env[k] = v
    }
  } catch {}
}

const require = createRequire(import.meta.url)
const { PrismaClient } = require('@prisma/client')
const url = process.env.DATABASE_URL || ''
const masked = url.replace(/:[^:@/]+@/, ':****@')
console.log('DB:', masked.split('@')[1] || '(unknown)')

const prisma = new PrismaClient({ datasources: { db: { url } } })
const EMAIL = 'high5ive@management.com'

async function main() {
  const user = await prisma.user.findUnique({ where: { email: EMAIL }, select: { id: true, email: true, name: true, role: true } })
  if (!user) { console.log(`\nNo user found for ${EMAIL}`); return }
  console.log('\nOWNER:', JSON.stringify(user))

  const restaurants = await prisma.restaurant.findMany({ where: { ownerId: user.id }, select: { id: true, name: true, joinCode: true } })
  console.log(`\nRESTAURANTS (${restaurants.length}):`)
  for (const r of restaurants) console.log('  -', r.name, `(${r.id})`)

  for (const r of restaurants) {
    const branches = await prisma.branch.findMany({ where: { restaurantId: r.id }, select: { id: true, name: true, code: true, type: true, isMain: true, isActive: true }, orderBy: { name: 'asc' } })
    console.log(`\n=== ${r.name} — ${branches.length} branches ===`)
    for (const b of branches) {
      const dishes = await prisma.dish.findMany({
        where: { branchId: b.id, deletedAt: null },
        select: { name: true, category: true, menuType: true, sellingPrice: true, isActive: true, description: true, variants: { where: { deletedAt: null }, select: { name: true, sellingPrice: true } } },
        orderBy: [{ category: 'asc' }, { name: 'asc' }],
      })
      console.log(`\n  ▸ BRANCH: ${b.name} [${b.type}${b.isMain ? ', MAIN' : ''}${b.isActive ? '' : ', INACTIVE'}] — ${dishes.length} dishes`)
      let cat = null
      for (const d of dishes) {
        if (d.category !== cat) { cat = d.category; console.log(`      • ${cat ?? 'Uncategorised'}`) }
        const v = d.variants.length ? `  [variants: ${d.variants.map(x => `${x.name} ${x.sellingPrice}`).join(', ')}]` : ''
        const desc = d.description ? `  — "${d.description}"` : ''
        console.log(`         ${d.name}  =${d.sellingPrice}  (${d.menuType ?? '?'})${d.isActive ? '' : ' [INACTIVE]'}${v}${desc}`)
      }
    }
  }
}

main().catch(e => { console.error('FATAL:', e.message) }).finally(() => prisma.$disconnect())
