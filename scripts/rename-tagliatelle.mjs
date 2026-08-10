/** Tiamo Pasta: rename Tagliatelli → Tagliatelle (dish + stock item). */
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

const dish = await prisma.dish.update({
  where: { id: 'cmrkk6j340004oub211be3r5i' },
  data: { name: 'Tagliatelle' },
  select: { name: true, branch: { select: { name: true } } },
})
const item = await prisma.inventoryItem.update({
  where: { id: 'cmrkk6iqn0002oub2as0s320o' },
  data: { name: 'Tagliatelle' },
  select: { name: true, branch: { select: { name: true } } },
})
console.log(`Dish: ${dish.name} (${dish.branch.name}); Stock item: ${item.name} (${item.branch.name})`)
await prisma.$disconnect()
