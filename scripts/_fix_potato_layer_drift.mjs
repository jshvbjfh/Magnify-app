/** Fix layer drift on WHATABURGER "Potato": item.quantity (382) doesn't match
 *  the sum of its InventoryPurchase.remainingQuantity (381), which locks the
 *  Edit/Delete buttons on its stock row (ingredientsWithLayerDrift check in
 *  RestaurantInventory.tsx). Reconciles item.quantity to the FIFO-layer sum,
 *  which is what consumption/costing treats as authoritative. UPDATE only. */
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
const url = new URL(process.env.DATABASE_URL)
url.searchParams.set('connection_limit', '3')
url.searchParams.set('pool_timeout', '30')
const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } })

const POTATO_ID = 'cmqjlt8d6000913q90xup8256'

const item = await prisma.inventoryItem.findUnique({ where: { id: POTATO_ID } })
if (!item) throw new Error('Potato item not found')

const purchases = await prisma.inventoryPurchase.findMany({
  where: { ingredientId: POTATO_ID },
  select: { id: true, remainingQuantity: true },
})
const layerSum = purchases.reduce((sum, p) => sum + Number(p.remainingQuantity || 0), 0)

console.log(`Potato item.quantity = ${item.quantity}`)
console.log(`Sum of purchase remainingQuantity (${purchases.length} batch(es)) = ${layerSum}`)

if (Math.abs(item.quantity - layerSum) <= 0.000001) {
  console.log('No drift detected — nothing to fix.')
} else {
  const updated = await prisma.inventoryItem.update({
    where: { id: POTATO_ID },
    data: { quantity: layerSum },
  })
  console.log(`Fixed: item.quantity set from ${item.quantity} -> ${updated.quantity}`)
}

await prisma.$disconnect()
