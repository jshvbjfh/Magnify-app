/**
 * One-time backfill: recompute unitCost for every existing prep.
 *
 * The fix in lib/prepCosting.ts only recalculates a prep's cost when its
 * sub-recipe is next edited. Every prep created before that fix — Chili oil,
 * Caramelized onions, Burger sauce, tomato slice, and the rest — still carries
 * whatever stale/zero value was stored when it was first created. This applies
 * the same recalculation to all of them, once, so the recipe editor and reports
 * are correct immediately rather than only after someone happens to touch each
 * prep's recipe again.
 *
 * Safe to re-run: it only ever overwrites unitCost with the sum the current
 * sub-recipe implies, nothing else.
 *
 * Run:  node scripts/_backfill_prep_costs.mjs            (dry run)
 *       node scripts/_backfill_prep_costs.mjs --apply
 */
import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'

function readEnvVar(file, key) {
  const content = fs.readFileSync(file, 'utf8')
  const line = content.split('\n').find((l) => l.startsWith(`${key}=`))
  return line ? line.slice(key.length + 1).trim().replace(/^"|"$/g, '') : null
}

const prisma = new PrismaClient({
  datasources: { db: { url: readEnvVar('.env.local', 'DATABASE_URL') } },
})

const apply = process.argv.includes('--apply')
const restaurantId = 'cmqia7buf0003n5p19gkoov3k'

// Excluded: sub-recipe entered as whole-batch quantities (e.g. "500g Flour")
// under a "per 1 unit of output" convention that means literally 1 gram — an
// 85kg-of-flour-per-dish landmine, not a cost bug. Needs the real per-gram
// ratio fixed at the source before any cost number is written on top of it.
const EXCLUDE_NAMES = new Set(['Hand-pulled noodles'])

const preps = await prisma.inventoryItem.findMany({
  where: { restaurantId, type: 'prep', deletedAt: null },
  select: {
    id: true,
    name: true,
    unit: true,
    unitCost: true,
    branch: { select: { name: true } },
  },
})

console.log(`Mode: ${apply ? '*** APPLY (writing) ***' : 'DRY-RUN (no writes)'}`)
console.log(`Found ${preps.length} preps for High 5ive\n`)

let changed = 0
for (const prep of preps) {
  if (EXCLUDE_NAMES.has(prep.name)) {
    console.log(`SKIP  ${(prep.name + ' (' + prep.branch.name + ')').padEnd(40)} excluded — sub-recipe needs fixing at the source first`)
    continue
  }

  const rows = await prisma.prepIngredient.findMany({
    where: { prepItemId: prep.id },
    select: { quantityRequired: true, ingredient: { select: { name: true, unitCost: true } } },
  })

  const newCost = rows.reduce(
    (sum, row) => sum + Number(row.quantityRequired || 0) * Number(row.ingredient.unitCost ?? 0),
    0,
  )

  const before = prep.unitCost ?? 0
  const label = `${prep.name} (${prep.branch.name})`

  if (rows.length === 0) {
    console.log(`SKIP  ${label.padEnd(40)} no sub-recipe yet — leaving at ${before}`)
    continue
  }

  if (Math.abs(before - newCost) < 0.01) {
    console.log(`OK    ${label.padEnd(40)} already ${before.toFixed(2)} RWF/${prep.unit}`)
    continue
  }

  console.log(`FIX   ${label.padEnd(40)} ${before.toFixed(2)} -> ${newCost.toFixed(2)} RWF/${prep.unit}`)
  changed++

  if (apply) {
    await prisma.inventoryItem.update({ where: { id: prep.id }, data: { unitCost: newCost } })
  }
}

console.log(`\n${changed} prep(s) ${apply ? 'updated' : 'would be updated'}.`)
if (!apply) console.log('Re-run with --apply to write these changes.')

await prisma.$disconnect()
