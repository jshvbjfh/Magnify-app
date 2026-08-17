// Read-only verification after the move.
import fs from 'fs'

const env = {}
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/)
  if (m) env[m[1]] = m[2]
}
for (const k of ['DATABASE_URL', 'DIRECT_URL']) if (env[k]) process.env[k] = env[k]

const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()

const TO_BRANCH = 'cmssorj59001qeab2zd2w07bo'
const moved = new Set(JSON.parse(fs.readFileSync('scripts/.sirocco-move-reverse-2026-08-14.json', 'utf8')).dishes.map(d => d.id))

const dishes = await p.dish.findMany({
  where: { branchId: TO_BRANCH, deletedAt: null },
  select: { id: true, name: true, category: true, createdAt: true, updatedAt: true },
  orderBy: { createdAt: 'desc' },
})

console.log(`COFFEE&BEVERAGE MANU now holds ${dishes.length} dishes`)
console.log(`  ${dishes.filter(d => moved.has(d.id)).length} came from the move`)
console.log('\nNot in the reverse map (were already in the bar, or added since):')
for (const d of dishes.filter(d => !moved.has(d.id))) {
  console.log(`  ${d.createdAt.toISOString()}  ${(d.category ?? '-').padEnd(16)} ${d.name}`)
}

await p.$disconnect()
