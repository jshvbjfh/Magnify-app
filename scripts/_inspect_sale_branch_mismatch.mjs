/** READ-ONLY: DishSale rows whose branchId differs from the dish's branchId
 *  (sales recorded under the till's station instead of the dish's station). */
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

const sales = await prisma.dishSale.findMany({
  where: { restaurantId: REST, deletedAt: null },
  select: {
    id: true, dishName: true, branchId: true, quantitySold: true, totalSaleAmount: true, saleDate: true,
    branch: { select: { name: true } },
    dish: { select: { branchId: true, branch: { select: { name: true } } } },
  },
})

const mismatched = sales.filter(s => s.dish && s.branchId !== s.dish.branchId)
console.log(`Total sales: ${sales.length}; mismatched station: ${mismatched.length}`)
const byPair = {}
for (const s of mismatched) {
  const key = `${s.dish.branch.name} dishes recorded under ${s.branch.name}`
  byPair[key] = (byPair[key] ?? 0) + 1
}
console.log('\nBy direction:')
for (const [k, v] of Object.entries(byPair).sort((a, b) => b[1] - a[1])) console.log(`  ${v}× ${k}`)

console.log('\nMost recent 15 mismatches:')
for (const s of mismatched.sort((a, b) => b.saleDate - a.saleDate).slice(0, 15)) {
  console.log(`  ${s.saleDate.toISOString().slice(0, 16)} ${s.dishName} ×${s.quantitySold} = ${s.totalSaleAmount} | dish@${s.dish.branch.name} recorded@${s.branch.name}`)
}

await prisma.$disconnect()
