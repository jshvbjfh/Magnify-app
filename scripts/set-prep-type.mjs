/**
 * Marks self-prepared items in Little Taipei as type='prep'.
 * Only UPDATEs existing InventoryItem records — never creates.
 * Run: node scripts/set-prep-type.mjs [--dry-run]
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

// Items that are made in-house at Little Taipei
const PREP_ITEM_NAMES = [
  'Dumpling wrappers',
  'Egg noodles (fresh)',
  'Hand-pulled noodles',
  'Wonton wrappers',
  'Wheat noodles (fresh)',
]

async function main() {
  const user = await prisma.user.findUnique({ where: { email: EMAIL }, select: { id: true } })
  if (!user) { console.log(`No user: ${EMAIL}`); return }

  const restaurants = await prisma.restaurant.findMany({ where: { ownerId: user.id }, select: { id: true, name: true } })

  for (const rest of restaurants) {
    const branches = await prisma.branch.findMany({
      where: { restaurantId: rest.id, name: { contains: 'Taipei' } },
      select: { id: true, name: true },
    })

    for (const branch of branches) {
      console.log(`\n${rest.name} / ${branch.name}`)
      if (DRY_RUN) console.log('DRY RUN — no changes written\n')

      for (const name of PREP_ITEM_NAMES) {
        const item = await prisma.inventoryItem.findFirst({
          where: { restaurantId: rest.id, branchId: branch.id, name },
          select: { id: true, name: true, unit: true, type: true },
        })

        if (!item) {
          console.log(`  ❌ NOT FOUND: ${name}`)
          continue
        }

        if (item.type === 'prep') {
          console.log(`  ✅ Already prep: ${name} (${item.unit})`)
          continue
        }

        console.log(`  ${DRY_RUN ? '[dry]' : '→'} ${name} (${item.unit})  purchased → prep`)
        if (!DRY_RUN) {
          await prisma.inventoryItem.update({ where: { id: item.id }, data: { type: 'prep' } })
        }
      }
    }
  }
}

main().catch(e => { console.error('FATAL:', e.message) }).finally(() => prisma.$disconnect())
