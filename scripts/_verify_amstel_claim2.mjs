/** READ-ONLY: what was inside the two orders whose payment entries were
 *  branded Little Taipei (2026-07-09 20:58 and 2026-07-10 20:30)? */
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

for (const day of ['2026-07-09', '2026-07-10']) {
  const sales = await prisma.dishSale.findMany({
    where: {
      restaurantId: REST, deletedAt: null,
      saleDate: { gte: new Date(`${day}T00:00:00Z`), lte: new Date(`${day}T23:59:59Z`) },
    },
    select: { saleDate: true, dishName: true, quantitySold: true, totalSaleAmount: true, branch: { select: { name: true } } },
    orderBy: { saleDate: 'asc' },
  })
  console.log(`\n=== ${day} sales (grouped by paid instant) ===`)
  let last = null
  for (const s of sales) {
    const t = s.saleDate.toISOString().slice(11, 19)
    if (t !== last) { last = t; console.log(`  -- paid at ${t} --`) }
    console.log(`     ${s.branch.name} | ${s.dishName} ×${s.quantitySold} = ${s.totalSaleAmount}`)
  }
}

await prisma.$disconnect()
