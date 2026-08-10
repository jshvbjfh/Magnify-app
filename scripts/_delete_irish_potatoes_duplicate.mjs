/** Delete the duplicate "Irish potatoes" item in WHATABURGER (0 stock, no
 *  recipe references, created as an accidental workaround while "Potato" was
 *  locked by layer drift). Verifies zero stock + zero recipe refs before deleting. */
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

const ID = 'cmrm2l8dh002u111443470m63'

const item = await prisma.inventoryItem.findUnique({ where: { id: ID } })
if (!item) { console.log('Already gone.'); process.exit(0) }
if (item.name !== 'Irish potatoes') throw new Error(`Safety check failed: expected "Irish potatoes", found "${item.name}"`)
if (item.quantity !== 0) throw new Error(`Safety check failed: expected 0 stock, found ${item.quantity}`)

const purchases = await prisma.inventoryPurchase.count({ where: { ingredientId: ID } })
const recipeRefs = await prisma.dishIngredient.count({ where: { inventoryItemId: ID } })
if (purchases > 0 || recipeRefs > 0) throw new Error(`Safety check failed: ${purchases} purchases, ${recipeRefs} recipe refs still reference this item`)

await prisma.inventoryItem.delete({ where: { id: ID } })
console.log(`Deleted "Irish potatoes" (${ID}).`)

await prisma.$disconnect()
