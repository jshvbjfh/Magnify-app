import { PrismaClient } from '@prisma/client'
process.env.DATABASE_URL = 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require'
const p = new PrismaClient()
const restaurantId = 'cmqia7buf0003n5p19gkoov3k'
const bananaBar = await p.branch.findFirst({ where: { restaurantId, name: 'Banana Bar' } })

// sheet: [dbItemName, sheetUnit, costPerSheetUnit] — costPerSheetUnit converted to per-base-unit
// Only entries I can map with confidence to an EXISTING item + matching base unit.
// KG -> g (divide by 1000), LITRE/LITE -> ml (divide by 1000), GRAMME -> g (as-is), SHOT -> shot (as-is), BOTTLE -> ml (needs bottle size, SKIPPED unless base unit is already 'bottle')
const rows = [
  ['Bacardi', 1545, 'shot'],       // DB unit: ml — SKIP, unit mismatch (bottle vs shot, no conversion given)
  ['Lemon', 2000/1000, 'g'],
  ['Sugar', 2000/1000, 'g'],
  ['Passion Fruit', 2000/1000, 'g'],
  ['Mint', 700, 'bunch'],          // DB unit: g — SKIP, unit mismatch
  ['Basil', 1000, 'bunch'],        // DB unit: g — SKIP, unit mismatch
  ['Strawberry', 3500, 'g'],       // GRAMME -> g as-is
  ['Pineapple', 1200/1000, 'g'],
  ['Coconut Cream', 3400, 'bottle'], // DB unit: ml — SKIP
  ['Tabay', 1625, 'shot'],
  ['Hibiscus', 4700/1000, 'g'],
  ['Cinnamon', 4500, 'g'],
  ['Campari', 2454, 'shot'],       // DB unit: ml — SKIP
  ['Martini', 1545, 'shot'],       // DB has 0-stock 'Martini' shot AND stocked 'Martini Rosso' ml — apply to 'Martini' (shot) directly, matches unit
  ['Red Rebal Whiskey', 1272, 'shot'],
  ['Orange', 5000/1000, 'g'],
  ['Grenadine', 11000, 'bottle'],  // DB unit: ml — SKIP
  ['Soda Water', 520, 'bottle'],   // DB unit: ml — SKIP
  ['Mango', 3000/1000, 'g'],
  ['Blue Curacao', 11000, 'bottle'], // DB unit: shots — SKIP, unit mismatch
  ['Watermelon', 5000/1000, 'g'],
  ['Ginger', 2000/1000, 'g'],
  ['Cucumber', 1500/1000, 'g'],
  ['Apple', 4500/1000, 'g'],
  ['Peanut Butter', 8300, 'g'],
  ['Milk', 1500/1000, 'ml'],       // LITRE -> ml
  ['Cocoa', 5000, 'g'],
  ['Banana', 2000/1000, 'piece'],  // DB unit: piece — SKIP, sheet gives KG not per-piece
  ['Vanilla Ice Cream', 8700/1000, 'ml'],
  ['Chocolate Ice Cream', 8700/1000, 'ml'],
  ['Chocolate Syrup', 5600/1000, 'ml'],
  ['Gordon Gin', 1227, 'shot'],
  ['Olmeca Tequila', 1100, 'shot'],
]

const items = await p.inventoryItem.findMany({ where: { branchId: bananaBar.id } })
const byName = new Map(items.map(i => [i.name.toLowerCase(), i]))

console.log('=== Would apply (unit matches, cost differs) ===')
const toUpdate = []
for (const [name, newCost, expectedUnit] of rows) {
  const item = byName.get(name.toLowerCase())
  if (!item) { console.log(`  SKIP (no item found): ${name}`); continue }
  if (item.unit.toLowerCase() !== expectedUnit.toLowerCase()) {
    console.log(`  SKIP (unit mismatch): ${name} — DB unit is '${item.unit}', sheet implies '${expectedUnit}'`)
    continue
  }
  const current = Number(item.unitCost)
  const next = Math.round(newCost * 10000) / 10000
  if (Math.abs(current - next) < 0.001) {
    console.log(`  OK already correct: ${name} (${current})`)
    continue
  }
  console.log(`  UPDATE: ${name} — ${current} -> ${next} (${item.unit})`)
  toUpdate.push({ id: item.id, name, from: current, to: next })
}

console.log('\n=== Summary ===')
console.log('Items to update:', toUpdate.length)
console.log(JSON.stringify(toUpdate, null, 2))

await p.$disconnect()
