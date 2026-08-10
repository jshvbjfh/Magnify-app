/**
 * Step 1 of High 5ive inventory fix:
 *   A) Split "Salt & pepper" into separate "Salt" + "Pepper" items.
 *   B) Create NEW inventory items (in the sheet's purchase units) for stock-sheet
 *      rows that have NO system counterpart, and fill each one's batch.
 * COST = line total → unitCost = cost / qty (when qty present).
 * Idempotent. DRY RUN by default; pass --commit to write.
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

// Branches that currently have a combined "Salt & pepper" item.
const SPLIT_BRANCHES = ['Tiamo Pasta', 'Little Taipei', 'THE GRILL']

// NEW items to create (no system counterpart): [name, unit, qty|null, cost(total)|null]
const NEW_ITEMS = {
  'Tiamo Pasta': [
    ['Parsley','bunch',null,700],['Bay leaves','pcs',1,null],['Rosemary','pcs',1,700],
    ['White pepper','pcs',1,null],['Oregano','pcs',2,null],['Chicken Masala','pcs',2,3600],
    ['Chilli Flakes','pcs',1,null],['Thyme','pcs',1,null],
  ],
  'Little Taipei': [
    ['Beef bones','kg',3,9000],['Onions','kg',4,4000],['Green beans','kg',1,1000],
    ['Coriander','bunch',1,500],['Tomatoes','kg',2,2200],
  ],
  'THE GRILL': [
    ['Mustard','pcs',2,14800],['Beef masala','pcs',1,3600],['Tomato paste','pcs',1,3800],
  ],
  'WHATABURGER': [
    ['Onions','kg',1,1500],['Mustard','pcs',1,6300],
  ],
}

async function getItem(branchId, name) {
  return prisma.inventoryItem.findFirst({ where: { branchId, name, deletedAt: null }, select: { id: true, unit: true } })
}

async function main() {
  console.log(`\n${COMMIT ? '🟢 COMMIT' : '🟡 DRY RUN'} — inventory step 1 (split salt/pepper + new items)\n`)
  const user = await prisma.user.findUnique({ where: { email: 'high5ive@management.com' }, select: { id: true } })
  const rest = await prisma.restaurant.findFirst({ where: { ownerId: user.id }, select: { id: true } })
  const branches = await prisma.branch.findMany({ where: { restaurantId: rest.id }, select: { id: true, name: true } })

  // ── A) Split Salt & pepper ──
  console.log('A) Split "Salt & pepper":')
  for (const bn of SPLIT_BRANCHES) {
    const branch = branches.find(b => b.name === bn); if (!branch) continue
    const combined = await getItem(branch.id, 'Salt & pepper')
    if (!combined) { console.log(`  [${bn}] no "Salt & pepper" — skip`); continue }
    for (const child of ['Salt', 'Pepper']) {
      const exists = await getItem(branch.id, child)
      if (exists) { console.log(`  [${bn}] "${child}" already exists — keep`); continue }
      console.log(`  [${bn}] + create "${child}" (${combined.unit})`)
      if (COMMIT) await prisma.inventoryItem.create({ data: { restaurantId: rest.id, branchId: branch.id, name: child, unit: combined.unit } })
    }
    console.log(`  [${bn}] - retire "Salt & pepper"`)
    if (COMMIT) await prisma.inventoryItem.update({ where: { id: combined.id }, data: { deletedAt: new Date() } })
  }

  // ── B) New items + batch ──
  console.log('\nB) New items from stock sheet (no system counterpart):')
  for (const [bn, rows] of Object.entries(NEW_ITEMS)) {
    const branch = branches.find(b => b.name === bn); if (!branch) continue
    for (const [name, unit, qty, cost] of rows) {
      const exists = await getItem(branch.id, name)
      if (exists) { console.log(`  [${bn}] = "${name}" exists — skip`); continue }
      const q = qty ?? 0
      const totalCost = cost ?? 0
      const unitCost = q > 0 && cost != null ? cost / q : 0
      const blanks = [qty == null ? 'qty' : null, cost == null ? 'cost' : null].filter(Boolean).join('+')
      console.log(`  [${bn}] + "${name}" ${q} ${unit} @ ${unitCost.toFixed(2)}/${unit} total=${totalCost}${blanks ? `  (blank: ${blanks})` : ''}`)
      if (COMMIT) {
        const item = await prisma.inventoryItem.create({ data: { restaurantId: rest.id, branchId: branch.id, name, unit, quantity: q, unitCost } })
        await prisma.inventoryPurchase.create({ data: { restaurantId: rest.id, branchId: branch.id, ingredientId: item.id, quantityPurchased: q, remainingQuantity: q, unitCost, totalCost } })
      }
    }
  }

  console.log(`\n${COMMIT ? 'Committed.' : 'Dry run — re-run with --commit to apply.'}\n`)
}
main().catch(e => console.error('FATAL:', e.message)).finally(() => prisma.$disconnect())
