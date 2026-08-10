/** READ-ONLY: verify the owner's report — Amstel (Parking Bar beer) revenue
 *  appearing inside Little Taipei's transaction ledger. */
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

const entries = await prisma.journalEntry.findMany({
  where: { restaurantId: REST, branchId: LT, deletedAt: null, description: { contains: 'Amstel' } },
  select: { id: true, entryDate: true, description: true, lines: { select: { debit: true, credit: true } } },
})
console.log(`Journal entries under LITTLE TAIPEI mentioning Amstel: ${entries.length}`)
for (const e of entries) {
  const amount = Math.max(...e.lines.map(l => l.debit), ...e.lines.map(l => l.credit))
  console.log(`\n${e.entryDate.toISOString()} — total ${amount} RWF booked to Little Taipei`)
  console.log(`  ${e.description}`)
}

await prisma.$disconnect()
