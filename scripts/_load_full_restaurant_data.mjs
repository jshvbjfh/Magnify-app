import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'

const dbPath = 'C:/Users/HP/AppData/Roaming/restaurant-app/data/dev.db'
const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } })

const dump = JSON.parse(fs.readFileSync('scripts/_full_restaurant_dump.json', 'utf8'))

function toDate(v) {
  return v ? new Date(v) : null
}

function convertDates(row, dateFields) {
  const out = { ...row }
  for (const f of dateFields) {
    if (f in out) out[f] = toDate(out[f])
  }
  return out
}

async function upsertAll(model, rows, dateFields, nullifyFields = [], uniqueKey = null) {
  let count = 0
  for (const raw of rows) {
    const row = convertDates(raw, dateFields)
    for (const f of nullifyFields) row[f] = null
    const where = uniqueKey
      ? { [uniqueKey.name]: Object.fromEntries(uniqueKey.fields.map((f) => [f, row[f]])) }
      : { id: row.id }
    await prisma[model].upsert({ where, update: row, create: row })
    count += 1
  }
  console.log(model.padEnd(24), count)
}

const COMMON = ['createdAt', 'updatedAt', 'deletedAt']

await upsertAll('dish', dump.dish, [...COMMON])
await upsertAll('dishVariant', dump.dishVariant, [...COMMON])
await upsertAll('inventoryItem', dump.inventoryItem, [...COMMON])
await upsertAll('dishIngredient', dump.dishIngredient, ['createdAt', 'updatedAt'], [], { name: 'dishId_inventoryItemId', fields: ['dishId', 'inventoryItemId'] })
await upsertAll('restaurantTable', dump.restaurantTable, [...COMMON])
await upsertAll('inventoryPurchase', dump.inventoryPurchase, ['purchasedAt', 'paidAt', ...COMMON], ['journalEntryId'])
{
  const purchaseIds = new Set(dump.inventoryPurchase.map((p) => p.id))
  const ingredientIds = new Set(dump.inventoryItem.map((i) => i.id))
  const validLedgerRows = dump.inventoryBatchUsageLedger.filter(
    (l) => purchaseIds.has(l.purchaseId) && ingredientIds.has(l.ingredientId),
  )
  const skipped = dump.inventoryBatchUsageLedger.length - validLedgerRows.length
  if (skipped > 0) console.log(`(skipping ${skipped} inventoryBatchUsageLedger rows with orphaned FK — pre-existing gap in source data)`)
  await upsertAll('inventoryBatchUsageLedger', validLedgerRows, ['consumedAt', 'createdAt', 'updatedAt'])
}
await upsertAll('inventoryAdjustmentLog', dump.inventoryAdjustmentLog, ['createdAt', 'updatedAt'])
await upsertAll('restaurantOrder', dump.restaurantOrder, ['paidAt', 'servedAt', 'canceledAt', 'arCollectedAt', ...COMMON], ['journalEntryId'])
await upsertAll('orderItem', dump.orderItem, ['readyAt', 'canceledAt', ...COMMON])
await upsertAll('dishSale', dump.dishSale, ['saleDate', ...COMMON])
await upsertAll('dishSaleIngredient', dump.dishSaleIngredient, ['createdAt', 'updatedAt'])
await upsertAll('wasteLog', dump.wasteLog, ['date', 'createdAt', 'updatedAt'])
await upsertAll('mepListItem', dump.mepListItem, [...COMMON])
await upsertAll('prepLog', dump.prepLog, ['createdAt', 'updatedAt'])
await upsertAll('employeeShift', dump.employeeShift, ['clockInAt', 'clockOutAt', ...COMMON])

await prisma.$disconnect()
console.log('\nDone.')
