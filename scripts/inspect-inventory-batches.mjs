/** READ-ONLY: inventory items + their FIFO batches (purchases) per branch for High 5ive. */
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

async function main() {
  const user = await prisma.user.findUnique({ where: { email: 'high5ive@management.com' }, select: { id: true } })
  const rest = await prisma.restaurant.findFirst({ where: { ownerId: user.id }, select: { id: true } })
  const branches = await prisma.branch.findMany({ where: { restaurantId: rest.id }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
  for (const b of branches) {
    const items = await prisma.inventoryItem.findMany({
      where: { branchId: b.id, deletedAt: null },
      select: { id: true, name: true, unit: true, quantity: true, unitCost: true,
        purchases: { where: { deletedAt: null }, select: { quantityPurchased: true, remainingQuantity: true, unitCost: true, totalCost: true, purchasedAt: true }, orderBy: { purchasedAt: 'asc' } } },
      orderBy: { name: 'asc' },
    })
    if (!items.length) { console.log(`\n=== ${b.name} — (no inventory items)`); continue }
    console.log(`\n=== ${b.name} — ${items.length} items ===`)
    for (const it of items) {
      console.log(`  ${it.name} | unit=${it.unit} | qty=${it.quantity} | unitCost=${it.unitCost} | batches=${it.purchases.length}`)
      for (const p of it.purchases) {
        console.log(`      batch: qty=${p.quantityPurchased} remaining=${p.remainingQuantity} unitCost=${p.unitCost} total=${p.totalCost} @ ${p.purchasedAt.toISOString().slice(0,10)}`)
      }
    }
  }
}
main().catch(e => console.error('FATAL:', e.message)).finally(() => prisma.$disconnect())
