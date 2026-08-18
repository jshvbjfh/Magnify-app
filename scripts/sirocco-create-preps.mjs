// Creates the Sirocco Y Sol prep items as empty shells on the LUNCH MENU
// station. Names only: no sub-recipes, no stock, no purchase layers — a prep
// shell carries quantity 0 until someone logs "Qty prepared" against it, so
// nothing here touches the batch view or the books.
//
// This is a deliberate, user-approved exception to the "never create
// InventoryItem by script" rule, which exists to stop phantom BATCH rows. A
// zero-stock prep with no InventoryPurchase cannot produce one.
//
// Re-runnable: an existing prep of the same name at the branch is skipped, not
// duplicated. Every created id is written to a reverse map so this is undoable.
//
//   node scripts/sirocco-create-preps.mjs          # dry run, writes nothing
//   node scripts/sirocco-create-preps.mjs --apply  # writes
import fs from 'fs'

const APPLY = process.argv.includes('--apply')

const env = {}
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/)
  if (m) env[m[1]] = m[2]
}
for (const k of ['DATABASE_URL', 'DIRECT_URL']) if (env[k]) process.env[k] = env[k]

const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()

const BRANCH_NAME = 'LUNCH MENU'
const REVERSE_FILE = 'scripts/.sirocco-preps-created-2026-08-15.json'

// Every prep the Opening Lunch Kitchen Manual builds the lunch menu on.
// All are weighed at service, so grams throughout.
const PREPS = [
  'Classic hummus',
  'Tzatziki',
  'Chicken souvlaki',
  'Grilled Mediterranean vegetables',
  'Moroccan couscous',
  'Harissa yogurt',
  'Falafel mix',
  'Saffron-style rice',
  'Quick pickled red onion',
  'Lemon-oregano dressing',
  'Moroccan lamb kefta',
  'Tahini sauce',
  'Spanish bravas sauce',
  'Garlic aioli',
  'Moroccan carrot salad base',
  'Garlic yogurt sauce',
  'Spanish paprika chicken',
  'Lemon herb sauce',
  'Basil herb sauce',
  'Garlic paste',
]

console.log('DB host:', (process.env.DATABASE_URL || '').match(/@([^/:?]+)/)?.[1] ?? '(none)')
console.log(APPLY ? 'MODE: APPLY — writing\n' : 'MODE: DRY RUN — nothing will be written\n')

const restaurant = await p.restaurant.findFirst({
  where: { name: { contains: 'rocco', mode: 'insensitive' }, deletedAt: null },
  select: { id: true, name: true, branches: { select: { id: true, name: true } } },
})
if (!restaurant) throw new Error('Sirocco restaurant not found')

const branch = restaurant.branches.find(b => b.name === BRANCH_NAME)
if (!branch) throw new Error(`Branch "${BRANCH_NAME}" not found`)
console.log(`${restaurant.name} → ${branch.name} (${branch.id})\n`)

// Match case-insensitively so a differently-cased hand-typed prep is not duplicated.
const existing = await p.inventoryItem.findMany({
  where: { restaurantId: restaurant.id, branchId: branch.id, deletedAt: null },
  select: { id: true, name: true, type: true },
})
const byName = new Map(existing.map(i => [i.name.trim().toLowerCase(), i]))

const created = []
let skipped = 0

for (const name of PREPS) {
  const hit = byName.get(name.toLowerCase())
  if (hit) {
    console.log(`  SKIP    ${name.padEnd(34)} already exists (${hit.type}, ${hit.id})`)
    skipped++
    continue
  }
  if (!APPLY) {
    console.log(`  WOULD   ${name.padEnd(34)} prep · g · qty 0`)
    continue
  }
  const item = await p.inventoryItem.create({
    data: {
      restaurantId: restaurant.id,
      branchId: branch.id,
      name,
      unit: 'g',
      type: 'prep',
      quantity: 0,
      unitCost: 0,
      reorderLevel: 0,
    },
    select: { id: true, name: true },
  })
  console.log(`  CREATED ${name.padEnd(34)} ${item.id}`)
  created.push(item)
}

console.log(`\n${APPLY ? 'created' : 'would create'}: ${APPLY ? created.length : PREPS.length - skipped}   skipped: ${skipped}`)

if (APPLY && created.length) {
  fs.writeFileSync(REVERSE_FILE, JSON.stringify({
    note: 'Prep shells created for Sirocco Y Sol LUNCH MENU. Delete these ids to undo.',
    createdAt: new Date().toISOString(),
    restaurantId: restaurant.id,
    branchId: branch.id,
    items: created,
  }, null, 2))
  console.log(`reverse map: ${REVERSE_FILE}`)
}

await p.$disconnect()
