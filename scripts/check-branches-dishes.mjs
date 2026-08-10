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

const user = await prisma.user.findUnique({ where: { email: 'high5ive@management.com' }, select: { id: true } })
const rest = await prisma.restaurant.findFirst({ where: { ownerId: user.id }, select: { id: true, name: true } })
const branches = await prisma.branch.findMany({ where: { restaurantId: rest.id }, select: { id: true, name: true, type: true, isMain: true }, orderBy: { name: 'asc' } })

console.log(`Restaurant: ${rest.name}\n`)
for (const b of branches) {
  const dishCount = await prisma.dish.count({ where: { branchId: b.id, deletedAt: null } })
  const cats = dishCount > 0 ? await prisma.dish.groupBy({ by: ['category'], where: { branchId: b.id, deletedAt: null }, _count: true }) : []
  console.log(`${b.name} [${b.type}${b.isMain ? ', MAIN' : ''}] — ${dishCount} dishes  id:${b.id}`)
  for (const c of cats) console.log(`   ${c.category ?? 'Uncategorised'}: ${c._count}`)
}
await prisma.$disconnect()
