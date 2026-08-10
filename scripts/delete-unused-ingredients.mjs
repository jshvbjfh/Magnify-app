/**
 * Delete ingredients confirmed as no longer used on the menu (0 active dish
 * links). Mirrors the app's own DELETE /api/restaurant/ingredients path:
 * hard delete (InventoryPurchase/DishIngredient cascade) + sync outbox entry
 * so waiter/kitchen devices pick up the removal.
 * DRY RUN by default. Pass --commit to write.
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
const COMMIT = process.argv.includes('--commit')

const TARGETS = {
  'WHATABURGER': ['Lettuce leaf', 'Jalapeños', 'Sour cream / sauce'],
  'Little Taipei': ['Teriyaki sauce', 'Sweet & sour sauce', 'Tahini / sesame paste', 'Water'],
  'Tiamo Pasta': ['Parmesan', 'Bay leaves', 'White pepper', 'Oregano', 'Chilli Flakes', 'Thyme'],
}

async function main() {
  console.log(`\n${COMMIT ? '🟢 COMMIT' : '🟡 DRY RUN'} — delete confirmed-unused ingredients\n`)

  const branches = await prisma.branch.findMany({ where: { name: { in: Object.keys(TARGETS) } }, select: { id: true, name: true, restaurantId: true } })
  let deleted = 0

  for (const [branchName, names] of Object.entries(TARGETS)) {
    const branch = branches.find(b => b.name === branchName)
    if (!branch) { console.log(`(branch not found: ${branchName})`); continue }
    console.log(`=== ${branchName} ===`)
    for (const name of names) {
      const item = await prisma.inventoryItem.findFirst({ where: { branchId: branch.id, name, deletedAt: null } })
      if (!item) { console.log(`  ✗ "${name}" not found — skip`); continue }

      const activeLinks = await prisma.dishIngredient.count({ where: { inventoryItemId: item.id, dish: { deletedAt: null } } })
      if (activeLinks > 0) { console.log(`  ⚠ "${name}" is linked to ${activeLinks} active dish(es) — REFUSING to delete, skip`); continue }

      console.log(`  - delete "${name}" (qty=${item.quantity} ${item.unit}, cost=${item.unitCost})`)
      deleted++
      if (COMMIT) {
        await prisma.inventoryItem.delete({ where: { id: item.id } })
        await prisma.syncOutbox.create({
          data: {
            scopeId: branch.restaurantId,
            restaurantId: branch.restaurantId,
            branchId: branch.id,
            entityType: 'inventoryItem',
            entityId: item.id,
            operation: 'delete',
            payload: JSON.stringify({ id: item.id }),
            mutationId: crypto.randomUUID(),
            availableAt: new Date(),
          },
        })
      }
    }
  }

  console.log(`\nDeleted: ${deleted} item(s).  ${COMMIT ? 'Committed.' : 'Dry run — re-run with --commit to apply.'}\n`)
}
main().catch(e => console.error('FATAL:', e.message)).finally(() => prisma.$disconnect())
