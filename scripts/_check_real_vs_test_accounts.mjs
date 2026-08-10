import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'

function readEnvVar(file, key) {
  const content = fs.readFileSync(file, 'utf8')
  const line = content.split('\n').find(l => l.startsWith(`${key}=`))
  if (!line) return null
  return line.slice(key.length + 1).trim().replace(/^"|"$/g, '')
}

const url = readEnvVar('.env.local', 'DATABASE_URL')
const prisma = new PrismaClient({ datasources: { db: { url } } })

const restaurants = await prisma.restaurant.findMany({
  select: {
    id: true, name: true, ownerId: true, managerId: true, deletedAt: true,
  },
})

const userIds = Array.from(new Set(restaurants.flatMap(r => [r.ownerId, r.managerId]).filter(Boolean)))
const users = await prisma.user.findMany({
  where: { id: { in: userIds } },
  select: { id: true, email: true, role: true },
})
const emailById = new Map(users.map(u => [u.id, u.email]))

console.log('=== RESTAURANTS ===')
console.log('NAME'.padEnd(28), 'OWNER EMAIL'.padEnd(34), 'PAID'.padStart(6), '  REAL?')
let realIds = []
for (const r of restaurants) {
  const email = emailById.get(r.ownerId) ?? emailById.get(r.managerId) ?? '(none)'
  const paid = await prisma.restaurantOrder.count({
    where: { restaurantId: r.id, status: 'PAID', deletedAt: null },
  })
  const isReal = email.endsWith('@management.com')
  if (isReal) realIds.push(r.id)
  console.log(
    (r.name ?? '(unnamed)').slice(0, 27).padEnd(28),
    email.slice(0, 33).padEnd(34),
    String(paid).padStart(6),
    isReal ? '  REAL' : '  test',
    r.deletedAt ? ' (deleted)' : ''
  )
}

console.log('\n=== ALL USERS ===')
const allUsers = await prisma.user.findMany({ select: { email: true, role: true } , orderBy: { email: 'asc' } })
for (const u of allUsers) {
  console.log(`  ${u.email.padEnd(38)} ${u.role}  ${u.email.endsWith('@management.com') ? 'REAL' : 'test'}`)
}

console.log('\nreal restaurant ids:', JSON.stringify(realIds))

await prisma.$disconnect()
