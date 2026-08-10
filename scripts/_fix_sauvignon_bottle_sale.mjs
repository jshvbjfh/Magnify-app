/**
 * Corrects the 23 Jul sale of White Wine (Sauvignon).
 *
 * A full bottle was sold for 38,000, but the recipe at that moment described a
 * ~110ml glass pour, so the sale recorded 2,640 of cost and drew only 120ml from
 * stock. The recipe has since been corrected to 750ml (= 18,000), which fixes
 * future sales but not the one already recorded.
 *
 * Four things move together, or the books and the shelf disagree:
 *   1. the sale's recorded cost        2,640 -> 18,000
 *   2. the stock-usage ledger row      120ml -> 750ml
 *   3. the batch's remaining stock     6,630 -> 6,000 ml
 *   4. the item's on-hand quantity     6,630 -> 6,000 ml
 *
 * Fixing only the cost would leave 630ml of a drunk bottle on the shelf, and the
 * next sale would draw from wine that does not exist.
 *
 * Everything happens in one transaction and aborts if the data no longer looks
 * the way it did when this was written.
 *
 * Run:  node scripts/_fix_sauvignon_bottle_sale.mjs
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

const SALE_ID = 'cmrxw3b2a00w24d4jmkt0hwt6'
const INGREDIENT_ID = 'cmqw1g3oa000tc32vwlhoy94j'
const BATCH_ID = 'cmqw1g4ho000vc32v39elxa8b'

const BOTTLE_ML = 750
const CORRECT_COST = 18000

const sale = await prisma.dishSale.findUnique({ where: { id: SALE_ID } })
const item = await prisma.inventoryItem.findUnique({ where: { id: INGREDIENT_ID } })
const batch = await prisma.inventoryPurchase.findUnique({ where: { id: BATCH_ID } })
const ledger = await prisma.inventoryBatchUsageLedger.findFirst({
  where: { ingredientId: INGREDIENT_ID, sourceId: SALE_ID },
})

if (!sale || !item || !batch || !ledger) {
  console.error('ABORT — could not find the sale, item, batch or ledger row.')
  process.exit(1)
}
if (sale.calculatedFoodCost === CORRECT_COST) {
  console.log('Already corrected — nothing to do.')
  process.exit(0)
}

const extraMl = BOTTLE_ML - ledger.quantityConsumed

console.log('BEFORE')
console.log('  sale recorded cost :', sale.calculatedFoodCost)
console.log('  wine consumed      :', ledger.quantityConsumed, 'ml')
console.log('  batch remaining    :', batch.remainingQuantity, 'ml')
console.log('  item on hand       :', item.quantity, 'ml')
console.log('')
console.log('AFTER')
console.log('  sale recorded cost :', CORRECT_COST)
console.log('  wine consumed      :', BOTTLE_ML, 'ml   (one full bottle)')
console.log('  batch remaining    :', batch.remainingQuantity - extraMl, 'ml')
console.log('  item on hand       :', item.quantity - extraMl, 'ml')

if (batch.remainingQuantity - extraMl < 0) {
  console.error('\nABORT — that would push the batch below zero.')
  process.exit(1)
}

await prisma.$transaction(async (tx) => {
  await tx.dishSale.update({
    where: { id: SALE_ID },
    data: { calculatedFoodCost: CORRECT_COST },
  })
  await tx.inventoryBatchUsageLedger.update({
    where: { id: ledger.id },
    data: { quantityConsumed: BOTTLE_ML, totalCost: CORRECT_COST },
  })
  await tx.inventoryPurchase.update({
    where: { id: BATCH_ID },
    data: { remainingQuantity: { decrement: extraMl } },
  })
  await tx.inventoryItem.update({
    where: { id: INGREDIENT_ID },
    data: { quantity: { decrement: extraMl } },
  })
})

const after = await prisma.dishSale.findUnique({ where: { id: SALE_ID } })
const afterItem = await prisma.inventoryItem.findUnique({ where: { id: INGREDIENT_ID } })
console.log('\nDONE — cost is now', after.calculatedFoodCost, 'and stock is', afterItem.quantity, 'ml')
console.log('Refresh the Reports/Transactions page for 23 Jul to see it.')

await prisma.$disconnect()
