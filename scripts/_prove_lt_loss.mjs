/** READ-ONLY: reconstruct Little Taipei's "today" (2026-07-14) P&L pieces —
 *  journal entries, dish sales with food costs, waste — to explain -6,205. */
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

const REST = 'cmqia7buf0003n5p19gkoov3k'
const LT = 'cmqiad2vx000in5p176jvqush'
// "Today" in Kigali time (UTC+2): 2026-07-14 00:00 → 23:59:59 +02:00
const from = new Date('2026-07-14T00:00:00+02:00')
const to = new Date('2026-07-14T23:59:59.999+02:00')

console.log('=== Journal entries for Little Taipei today ===')
const entries = await prisma.journalEntry.findMany({
  where: { restaurantId: REST, branchId: LT, deletedAt: null, entryDate: { gte: from, lte: to } },
  include: { lines: { include: { account: { include: { category: true } } } } },
  orderBy: { entryDate: 'asc' },
})
let income = 0, expense = 0
for (const e of entries) {
  const cr = e.lines.find(l => l.credit > 0)
  const dr = e.lines.find(l => l.debit > 0)
  const amount = dr?.debit ?? cr?.credit ?? 0
  const isIncome = cr?.account?.category?.type === 'income'
  const isExpense = dr?.account?.category?.type === 'expense'
  if (isIncome) income += amount
  if (isExpense) expense += amount
  console.log(`  ${e.entryDate.toISOString().slice(11, 19)} ${isIncome ? 'IN ' : isExpense ? 'OUT' : '?  '} ${amount} | ${dr?.account?.name} ← ${cr?.account?.name} | ${(e.description ?? '').slice(0, 90)}`)
}
console.log(`  → income ${income}, expense ${expense}, net ${income - expense}`)

console.log('\n=== Dish sales for Little Taipei today (with food cost) ===')
const sales = await prisma.dishSale.findMany({
  where: { restaurantId: REST, branchId: LT, deletedAt: null, saleDate: { gte: from, lte: to } },
  select: { saleDate: true, dishName: true, quantitySold: true, totalSaleAmount: true, calculatedFoodCost: true },
})
let rev = 0, cost = 0
for (const s of sales) {
  rev += s.totalSaleAmount; cost += s.calculatedFoodCost
  console.log(`  ${s.saleDate.toISOString().slice(11, 19)} ${s.dishName} ×${s.quantitySold} = ${s.totalSaleAmount}, foodCost ${s.calculatedFoodCost}`)
}
console.log(`  → revenue ${rev}, food cost ${cost}, gross ${rev - cost}`)

console.log('\n=== Waste logs for Little Taipei today ===')
const waste = await prisma.wasteLog.findMany({
  where: { restaurantId: REST, branchId: LT, deletedAt: null, date: { gte: from, lte: to } },
  select: { date: true, quantityWasted: true, calculatedCost: true, reason: true, notes: true, ingredient: { select: { name: true, unit: true } } },
})
let wasteTotal = 0
for (const w of waste) {
  wasteTotal += w.calculatedCost
  console.log(`  ${w.date.toISOString().slice(11, 19)} ${w.ingredient.name} ${w.quantityWasted}${w.ingredient.unit} = ${w.calculatedCost} (${w.reason}) ${w.notes ? '— ' + w.notes.slice(0, 60) : ''}`)
}
console.log(`  → waste total ${wasteTotal}`)

await prisma.$disconnect()
