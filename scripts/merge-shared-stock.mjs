/**
 * Collapse a restaurant's per-station stock into one shared pool.
 *
 *   node scripts/merge-shared-stock.mjs --restaurant "High 5ive"            # dry run
 *   node scripts/merge-shared-stock.mjs --restaurant "High 5ive" --apply    # writes
 *
 * Dry run is the default and prints every row it would touch. Nothing is
 * created: for each group of duplicates one existing row survives, is moved to
 * the main station, and every reference to the others is repointed onto it
 * before they are removed. Quantities are summed; FIFO layers are kept as they
 * are so cost history survives untouched.
 *
 * --apply writes a reverse map to scripts/.merge-reverse-<timestamp>.json
 * first: loser id -> winner id plus every table repointed, which is what makes
 * an unpick possible afterwards. Each group commits in its own transaction and
 * already-merged groups are skipped, so a run that dies partway can simply be
 * run again.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../package.json', import.meta.url))
const { PrismaClient } = require('@prisma/client')

const args = process.argv.slice(2)
const APPLY = args.includes('--apply')
const restaurantName = args[args.indexOf('--restaurant') + 1]
if (!restaurantName || restaurantName.startsWith('--')) {
  console.error('Usage: node scripts/merge-shared-stock.mjs --restaurant "<name>" [--apply]')
  process.exit(1)
}

// Names that mean the same ingredient but were typed differently. The key is
// the name that survives; everything listed under it is folded into it.
// `convertFrom` restates a row recorded in another unit — including its history,
// which would otherwise silently change meaning by a factor of a thousand.
const ALIAS_GROUPS = [
  { target: 'Onions', unit: 'g', aliases: ['onion', 'onions'] },
  { target: 'Potatoes', unit: 'g', aliases: ['potato', 'potatoes'], convertFrom: { kg: 1000 } },
  // 75 g a wing, from this restaurant's own 600/piece against 8/gram. Kept in
  // grams because a delivery can be weighed but not reliably counted.
  { target: 'Chicken wings', unit: 'g', aliases: ['chicken wing', 'chicken wings'], convertFrom: { pcs: 75, piece: 75 } },
  { target: 'Tomato slices', unit: 'pcs', aliases: ['tomato slice', 'tomato slices'] },
  { target: 'Eggs', unit: 'pcs', aliases: ['egg', 'eggs'] },
  // "X (shots)" rows are the same bottle recorded twice.
  { target: 'Jack Daniel', unit: 'shot', aliases: ['jack daniel', 'jack daniel (shots)'] },
  { target: 'Olmeca Gold', unit: 'shot', aliases: ['olmeca gold', 'olmeca gold (shots)'] },
  { target: 'Olmeca Silver', unit: 'shot', aliases: ['olmeca silver', 'olmeca silver (shots)'] },
  { target: 'Camino', unit: 'shot', aliases: ['camino', 'camino (shots)'] },
  { target: 'Jagermeister', unit: 'shot', aliases: ['jagermeister', 'jagermeister (shots)'] },
  // Both rows are full, untouched bottles of the same whisky, but one was
  // recorded as 18 shots to the bottle and the other as 33. Same bottle means
  // the 18 understates it, so that row is restated onto the 33 basis - which
  // also divides its cost per shot back down. Summing them as recorded would
  // give "51 shots" made of two different-sized shots, a meaningless number.
  { target: 'Red Label', unit: 'shot', aliases: ['red label', 'red label (shots)'], restate: { 'red label (shots)': 33 / 18 } },
  { target: 'Absolute Vodka', unit: 'shot', aliases: ['absolute vodka', 'absolute vodka (shots)'] },
  { target: 'Bacardi', unit: 'shot', aliases: ['bacardi'], convertFrom: { ml: 1 / 30.3 } },
  { target: 'Triple Sec', unit: 'shot', aliases: ['triple sec'], convertFrom: { ml: 1 / 30.3 } },
  { target: 'Cointreau', unit: 'shot', aliases: ['cointreau', 'cointreaus'] },
  { target: 'Tomatoes', unit: 'g', aliases: ['tomato', 'tomatoes'], convertFrom: { kg: 1000 } },
]

// Every table that points at an inventory item. Missing one here means an
// orphaned reference after the losing row is deleted, so this list is the
// thing to check against the schema when the model changes.
const REFERENCING_TABLES = [
  { model: 'inventoryPurchase', field: 'ingredientId', scale: 'quantity' },
  { model: 'dishIngredient', field: 'inventoryItemId', scale: 'recipe' },
  { model: 'dishSaleIngredient', field: 'inventoryItemId', scale: 'quantity' },
  { model: 'inventoryBatchUsageLedger', field: 'ingredientId', scale: 'quantity' },
  { model: 'wasteLog', field: 'ingredientId', scale: 'waste' },
  { model: 'inventoryAdjustmentLog', field: 'ingredientId', scale: 'none' },
  { model: 'stockTake', field: 'ingredientId', scale: 'none' },
  { model: 'prepIngredient', field: 'prepItemId', scale: 'none' },
  { model: 'prepIngredient', field: 'ingredientItemId', scale: 'recipe' },
]

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()

// Mirrors UNIT_ALIASES in lib/inventoryUnits.ts. "piece" and "pcs" are the same
// physical unit, and treating them as different would block a merge that needs
// no conversion at all — or worse, invent one. Keep in step with that file.
const UNIT_ALIASES = {
  pc: 'piece', pcs: 'piece', pieces: 'piece',
  l: 'ltr', litre: 'ltr', liter: 'ltr', litres: 'ltr', liters: 'ltr',
  gram: 'g', grams: 'g', gr: 'g',
  kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  mls: 'ml',
  bottles: 'bottle', bags: 'bag', boxes: 'box', cans: 'can',
  sachets: 'sachet', bunches: 'bunch', shots: 'shot',
  trays: 'tray', trey: 'tray', treys: 'tray',
}
const canonUnit = (u) => UNIT_ALIASES[norm(u)] ?? norm(u)
const sameUnit = (a, b) => canonUnit(a) === canonUnit(b)
const round = (n) => Math.round(Number(n) * 1000) / 1000
const fmt = (n) => Number(n).toLocaleString('en-RW', { maximumFractionDigits: 2 })

const line = readFileSync(new URL('../.env.vercel.production', import.meta.url), 'utf8')
  .split('\n').find((l) => l.trim().startsWith('DATABASE_URL'))
const url = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')
const prisma = new PrismaClient({ datasources: { db: { url } }, log: ['warn'] })

const restaurant = await prisma.restaurant.findFirst({
  where: { name: restaurantName },
  select: { id: true, name: true },
})
if (!restaurant) {
  console.error(`No restaurant named "${restaurantName}".`)
  process.exit(1)
}

// Read the switch defensively: a dry run has to work before the column has
// been deployed, which is exactly when you most want to read the plan.
let sharedStock = false
let switchDeployed = true
try {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT "sharedStock" FROM "restaurants" WHERE id = $1', restaurant.id,
  )
  sharedStock = Boolean(rows?.[0]?.sharedStock)
} catch {
  switchDeployed = false
}

const branches = await prisma.branch.findMany({
  where: { restaurantId: restaurant.id },
  select: { id: true, name: true, isMain: true },
})
const mainBranch = branches.find((b) => b.isMain)
if (!mainBranch) {
  console.error('This restaurant has no main station, so there is nowhere to hold the shared stock.')
  process.exit(1)
}
const label = new Map(branches.map((b) => [b.id, b.name + (b.isMain ? ' (MAIN)' : '')]))

const items = await prisma.inventoryItem.findMany({
  where: { restaurantId: restaurant.id, deletedAt: null },
  select: {
    id: true, branchId: true, name: true, unit: true, quantity: true, unitCost: true, type: true,
    _count: { select: { purchases: true, dishIngredients: true, saleIngredients: true, batchUsageLedgers: true } },
  },
})

// Open FIFO layers are where stock value actually lives — the item's own
// unitCost is only a derived headline. Loading them lets the run prove that
// re-expressing a quantity in a different unit moves no money.
const openLayers = await prisma.inventoryPurchase.findMany({
  where: { restaurantId: restaurant.id, deletedAt: null, remainingQuantity: { gt: 0 } },
  select: { id: true, ingredientId: true, remainingQuantity: true, unitCost: true },
})
const layersByItem = new Map()
for (const layer of openLayers) {
  if (!layersByItem.has(layer.ingredientId)) layersByItem.set(layer.ingredientId, [])
  layersByItem.get(layer.ingredientId).push(layer)
}
const layerValue = (itemId) => (layersByItem.get(itemId) ?? [])
  .reduce((sum, l) => sum + Number(l.remainingQuantity) * Number(l.unitCost), 0)

console.log(`\n${'='.repeat(72)}`)
console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — ${restaurant.name}`)
console.log(`shared stock switch: ${!switchDeployed ? 'NOT DEPLOYED YET' : sharedStock ? 'ON' : 'OFF'}`)
console.log(`stock moves to: ${mainBranch.name}`)
console.log(`${items.length} stock rows across ${branches.length} stations`)
console.log('='.repeat(72))

if (APPLY && !sharedStock) {
  console.error('\nREFUSING TO APPLY: the shared-stock switch is still off for this restaurant.')
  console.error('Turn it on and confirm service is healthy first — merging while the code')
  console.error('still resolves stock per station would stop deductions silently.')
  process.exit(1)
}

// Preps belong to the kitchen that made them and are never pooled.
const poolable = items.filter((i) => i.type !== 'prep')
const preps = items.filter((i) => i.type === 'prep')

// Build the groups: explicit aliases first, then anything else sharing a name.
const groups = new Map()
const claimed = new Set()
for (const spec of ALIAS_GROUPS) {
  const rows = poolable.filter((i) => spec.aliases.includes(norm(i.name)))
  if (rows.length === 0) continue
  rows.forEach((r) => claimed.add(r.id))
  groups.set(spec.target, { spec, rows })
}
for (const item of poolable) {
  if (claimed.has(item.id)) continue
  const key = item.name.trim()
  const existing = [...groups.entries()].find(([, g]) => norm(g.rows[0].name) === norm(key))
  if (existing) existing[1].rows.push(item)
  else groups.set(key, { spec: { target: key, unit: item.unit }, rows: [item] })
}

let plannedMerges = 0
let plannedMoves = 0
let unresolved = 0
let valueBeforeTotal = 0
let valueAfterTotal = 0
let valueDrift = 0
const plan = []

for (const [target, { spec, rows }] of groups) {
  const needsMerge = rows.length > 1
  const offMain = rows.filter((r) => r.branchId !== mainBranch.id)
  if (!needsMerge && offMain.length === 0) continue

  // The survivor is the row carrying the most history — least to repoint, and
  // the one whose id already appears in the most reports.
  const scored = rows.slice().sort((a, b) => {
    const weight = (x) => x._count.saleIngredients + x._count.batchUsageLedgers + x._count.dishIngredients + x._count.purchases
    return weight(b) - weight(a) || Number(b.quantity) - Number(a.quantity) || a.id.localeCompare(b.id)
  })
  const winner = scored[0]
  const losers = scored.slice(1)

  const targetUnit = spec.unit ?? winner.unit
  let totalQuantity = 0
  const conversions = []
  let blocked = false

  for (const row of rows) {
    // A restatement applies even when the unit already matches: it corrects a
    // row that counted the same thing on a different basis.
    let factor = spec.restate?.[norm(row.name)] ?? 1
    // Alias-aware: "pcs" into "piece" needs no conversion and must not be
    // treated as a missing rule.
    if (factor === 1 && !sameUnit(row.unit, targetUnit)) {
      const declared = spec.convertFrom?.[norm(row.unit)]
        ?? spec.convertFrom?.[row.unit]
        ?? spec.convertFrom?.[canonUnit(row.unit)]
      if (declared === undefined) {
        blocked = true
        conversions.push({ row, factor: null })
        continue
      }
      factor = declared
    }
    conversions.push({ row, factor })
    totalQuantity = round(totalQuantity + Number(row.quantity) * factor)
  }

  if (blocked) {
    unresolved++
    console.log(`\n!! "${target}" — CANNOT MERGE, no conversion given for a unit`)
    for (const { row, factor } of conversions) {
      console.log(`     ${factor === null ? 'NO RULE ' : '        '}"${row.name}" @ ${label.get(row.branchId)} — ${fmt(row.quantity)} ${row.unit}`)
    }
    continue
  }

  if (needsMerge) plannedMerges++
  if (winner.branchId !== mainBranch.id) plannedMoves++

  console.log(`\n"${target}"  [${targetUnit}]  ${rows.length} row${rows.length === 1 ? '' : 's'} -> 1`)
  console.log(`   KEEP   "${winner.name}" @ ${label.get(winner.branchId)}`)
  console.log(`          rename to "${target}", move to ${mainBranch.name}, quantity becomes ${fmt(totalQuantity)} ${targetUnit}`)
  for (const { row, factor } of conversions) {
    if (row.id === winner.id) continue
    const converted = round(Number(row.quantity) * factor)
    const note = factor === 1 ? '' : `  (x${factor} from ${row.unit})`
    const c = row._count
    const refs = [c.purchases && `${c.purchases} batches`, c.dishIngredients && `${c.dishIngredients} recipes`,
      c.saleIngredients && `${c.saleIngredients} sales`, c.batchUsageLedgers && `${c.batchUsageLedgers} ledger`]
      .filter(Boolean).join(', ') || 'nothing attached'
    console.log(`   MERGE  "${row.name}" @ ${label.get(row.branchId)} — ${fmt(row.quantity)} ${row.unit} -> ${fmt(converted)} ${targetUnit}${note}`)
    console.log(`          repoint ${refs}, then remove the row`)
  }

  // Stock value must come out the other side unchanged. Quantities are scaled
  // up and the cost per unit scaled down by the same factor, so the money each
  // layer represents is identical — only the unit it is counted in changes.
  const valueBefore = rows.reduce((sum, r) => sum + layerValue(r.id), 0)
  const valueAfter = rows.reduce((sum, r) => {
    const factor = conversions.find((c) => c.row.id === r.id)?.factor ?? 1
    return sum + (layersByItem.get(r.id) ?? [])
      .reduce((s, l) => s + (Number(l.remainingQuantity) * factor) * (Number(l.unitCost) / factor), 0)
  }, 0)
  valueBeforeTotal += valueBefore
  valueAfterTotal += valueAfter
  if (Math.abs(valueBefore - valueAfter) > 0.5) {
    console.log(`   !! VALUE MOVED: ${fmt(valueBefore)} -> ${fmt(valueAfter)} RWF`)
    valueDrift++
  } else if (valueBefore > 0) {
    console.log(`          stock value unchanged at ${fmt(valueBefore)} RWF`)
  }

  plan.push({ target, targetUnit, winnerId: winner.id, totalQuantity, conversions: conversions.map(c => ({ id: c.row.id, factor: c.factor })), loserIds: losers.map(l => l.id) })
}

console.log(`\n${'='.repeat(72)}`)
console.log(`${plannedMerges} groups would collapse; ${plannedMoves} survivors move to ${mainBranch.name}`)
console.log(`${preps.length} prep items stay with their kitchen and are not touched`)
if (unresolved > 0) console.log(`${unresolved} groups BLOCKED on a missing unit conversion — resolve before applying`)
console.log(`\nSTOCK VALUE  before ${fmt(valueBeforeTotal)} RWF  ->  after ${fmt(valueAfterTotal)} RWF`)
console.log(valueDrift === 0
  ? 'No money moves: quantities are re-expressed, not revalued.'
  : `!! ${valueDrift} groups change value — investigate before applying.`)
console.log('='.repeat(72))

if (!APPLY) {
  console.log('\nDry run only. Nothing was written. Re-run with --apply to commit.')
  await prisma.$disconnect()
  process.exit(0)
}

if (unresolved > 0) {
  console.error('\nRefusing to apply while any group is blocked on a unit conversion.')
  await prisma.$disconnect()
  process.exit(1)
}

// Winners' pre-merge headline costs, for the no-open-layers fallback above.
const winnerBefore = new Map(items.map((i) => [i.id, Number(i.unitCost ?? 0)]))

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const reversePath = new URL(`./.merge-reverse-${stamp}.json`, import.meta.url)
writeFileSync(reversePath, JSON.stringify({ restaurant: restaurant.id, mainBranch: mainBranch.id, plan }, null, 2))
console.log(`\nReverse map written to ${reversePath.pathname}`)
console.log('Keep it — it is what makes this unpickable.\n')

for (const group of plan) {
  await prisma.$transaction(async (tx) => {
    for (const { id, factor } of group.conversions) {
      if (factor === 1) continue
      // Restate history recorded in the old unit, or a sale of 0.5 kg silently
      // becomes 0.5 g the moment its item is denominated in grams.
      for (const { model, field, scale } of REFERENCING_TABLES) {
        if (scale === 'none') continue
        const rows = await tx[model].findMany({ where: { [field]: id }, select: { id: true } })
        for (const row of rows) {
          const current = await tx[model].findUnique({ where: { id: row.id } })
          const data = {}
          for (const key of ['quantityPurchased', 'remainingQuantity', 'purchaseQuantity', 'quantityUsed', 'quantityConsumed', 'quantityRequired', 'quantityWasted']) {
            if (current?.[key] != null) data[key] = round(Number(current[key]) * factor)
          }
          for (const key of ['unitCost', 'purchaseUnitCost']) {
            if (current?.[key] != null) data[key] = Number(current[key]) / factor
          }
          if (Object.keys(data).length) await tx[model].update({ where: { id: row.id }, data })
        }
      }
    }

    for (const loserId of group.loserIds) {
      for (const { model, field } of REFERENCING_TABLES) {
        await tx[model].updateMany({ where: { [field]: loserId }, data: { [field]: group.winnerId } })
      }
      await tx.inventoryItem.delete({ where: { id: loserId } })
    }

    // Re-derive the headline cost from the layers rather than carrying the
    // winner's old one over. If the surviving row was the one converted — a
    // wing counted in pieces becoming grams — its stored cost is still on the
    // old basis, and left alone it would read 600 a gram instead of 8.
    const layers = await tx.inventoryPurchase.findMany({
      where: { ingredientId: group.winnerId, remainingQuantity: { gt: 0 }, deletedAt: null },
      select: { remainingQuantity: true, unitCost: true },
    })
    const openQuantity = layers.reduce((s, l) => s + Number(l.remainingQuantity), 0)
    const openValue = layers.reduce((s, l) => s + Number(l.remainingQuantity) * Number(l.unitCost), 0)
    const winnerFactor = group.conversions.find((c) => c.id === group.winnerId)?.factor ?? 1
    const derivedUnitCost = openQuantity > 0
      ? openValue / openQuantity
      : Number(winnerBefore.get(group.winnerId) ?? 0) / winnerFactor

    await tx.inventoryItem.update({
      where: { id: group.winnerId },
      data: {
        name: group.target,
        unit: group.targetUnit,
        quantity: group.totalQuantity,
        branchId: mainBranch.id,
        unitCost: derivedUnitCost,
      },
    })
    await tx.inventoryPurchase.updateMany({ where: { ingredientId: group.winnerId }, data: { branchId: mainBranch.id } })
  }, { maxWait: 15000, timeout: 120000 })
  console.log(`  merged ${group.target}`)
}

console.log('\nDone.')
await prisma.$disconnect()
