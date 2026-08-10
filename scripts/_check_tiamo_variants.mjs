/** READ-ONLY: variants on Tiamo Pasta dishes (price change pre-flight). */
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

const variants = await prisma.dishVariant.findMany({
  where: { dish: { branchId: 'cmqiadl7h000nn5p1trr8hdcc' }, deletedAt: null },
  select: { name: true, sellingPrice: true, dish: { select: { name: true, category: true } } },
})
console.log(JSON.stringify(variants, null, 2))
await prisma.$disconnect()
