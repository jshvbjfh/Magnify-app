/**
 * Fills in the missing cost on two Parking Bar sales from 23 Jul.
 *
 * Both dishes were sold while they had no recipe attached, so the sale recorded
 * 0 cost and the whole sale price fell through as profit. The recipes now exist
 * (Wine by the glass = 200ml Merlot @ 24 = 4,800; Coke = 1 bottle @ 520), so the
 * cost each sale genuinely incurred can be filled in.
 *
 * Cost only — stock is deliberately left alone. The Merlot level (500ml, after
 * the bottle was redefined as 750ml @ 18,000) was entered by hand to match a
 * physical count, so it already accounts for the wine these glasses used.
 * Deducting again here would subtract the same wine twice.
 *
 * Run:  node scripts/_fix_jul23_zero_costs.mjs
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

// unit cost comes from each dish's current recipe: 200ml Merlot @24, 1 bottle @520
const FIXES = [
  { id: 'cmrxw31nz00c94d4jx7jauf28', label: 'Wine by the glass x3', unitCost: 4800 },
  { id: 'cmrxw2xt0007b4d4jbzusb5d9', label: 'Coke x1', unitCost: 520 },
]

let applied = 0
let addedCost = 0

for (const fix of FIXES) {
  const sale = await prisma.dishSale.findUnique({ where: { id: fix.id } })
  if (!sale) {
    console.log(`SKIP ${fix.label} — sale not found`)
    continue
  }
  if (sale.calculatedFoodCost !== 0) {
    console.log(`SKIP ${fix.label} — already has cost ${sale.calculatedFoodCost}`)
    continue
  }

  const cost = sale.quantitySold * fix.unitCost
  await prisma.dishSale.update({
    where: { id: fix.id },
    data: { calculatedFoodCost: cost },
  })
  console.log(`FIXED ${fix.label}: cost 0 -> ${cost}  (revenue ${sale.totalSaleAmount})`)
  applied++
  addedCost += cost
}

console.log(`\nApplied ${applied} fix(es); ${addedCost} of cost added to Parking Bar on 23 Jul.`)
console.log('Refresh the Transactions page for 23 Jul — Cost of Goods rises and Sales Profit falls by that amount.')
console.log('\nStock untouched: Merlot needs a physical count before its level can be trusted.')

await prisma.$disconnect()
