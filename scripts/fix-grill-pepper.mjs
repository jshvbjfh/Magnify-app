/**
 * THE GRILL: rename "Pepper" -> "Black pepper", correct quantity 1000g -> 60g
 * (real-world correction from the manager). Cost stays 3.5 RWF/g (unchanged).
 * Also deletes the leftover "Salt & pepper" combined-item duplicates on
 * THE GRILL and Tiamo Pasta (superseded by the already-split Salt/Pepper
 * items, 0 qty / 0 cost, confirmed not a real ingredient).
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

async function main() {
  console.log(`\n${COMMIT ? '🟢 COMMIT' : '🟡 DRY RUN'} — fix Pepper naming + delete Salt & pepper leftovers\n`)

  const grill = await prisma.branch.findFirst({ where: { name: 'THE GRILL' }, select: { id: true } })
  const pepper = await prisma.inventoryItem.findFirst({ where: { branchId: grill.id, name: 'Pepper', deletedAt: null } })
  if (pepper) {
    console.log(`THE GRILL: rename "Pepper" -> "Black pepper", qty ${pepper.quantity}g -> 60g (cost stays ${pepper.unitCost})`)
    if (COMMIT) {
      await prisma.inventoryItem.update({ where: { id: pepper.id }, data: { name: 'Black pepper', quantity: 60 } })
    }
  } else {
    console.log('THE GRILL: "Pepper" not found — skip')
  }

  for (const branchName of ['THE GRILL', 'Tiamo Pasta']) {
    const branch = await prisma.branch.findFirst({ where: { name: branchName }, select: { id: true } })
    const leftover = await prisma.inventoryItem.findFirst({ where: { branchId: branch.id, name: 'Salt & pepper', deletedAt: null } })
    if (!leftover) { console.log(`${branchName}: "Salt & pepper" not found — skip`); continue }
    const activeLinks = await prisma.dishIngredient.count({ where: { inventoryItemId: leftover.id, dish: { deletedAt: null } } })
    if (activeLinks > 0) { console.log(`${branchName}: "Salt & pepper" linked to ${activeLinks} active dish(es) — REFUSING to delete`); continue }
    console.log(`${branchName}: delete leftover "Salt & pepper" (qty=${leftover.quantity}, cost=${leftover.unitCost})`)
    if (COMMIT) await prisma.inventoryItem.delete({ where: { id: leftover.id } })
  }

  console.log(`\n${COMMIT ? 'Committed.' : 'Dry run — re-run with --commit to apply.'}\n`)
}
main().catch(e => console.error('FATAL:', e.message)).finally(() => prisma.$disconnect())
