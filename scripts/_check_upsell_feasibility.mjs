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

const total = await prisma.restaurantOrder.count({ where: { deletedAt: null } })
const paid = await prisma.restaurantOrder.count({
  where: { deletedAt: null, paidAt: { not: null } },
})
const withStaff = await prisma.restaurantOrder.count({
  where: { deletedAt: null, paidAt: { not: null }, staffId: { not: null } },
})
const withCreatedBy = await prisma.restaurantOrder.count({
  where: { deletedAt: null, paidAt: { not: null }, createdByName: { not: null } },
})
const withGuests = await prisma.restaurantOrder.count({
  where: { deletedAt: null, paidAt: { not: null }, guestCount: { not: null } },
})

console.log('=== ORDERS ===')
console.log('total (not deleted):', total)
console.log('paid:', paid)
console.log('paid w/ staffId:    ', withStaff, pct(withStaff, paid))
console.log('paid w/ createdByName:', withCreatedBy, pct(withCreatedBy, paid))
console.log('paid w/ guestCount: ', withGuests, pct(withGuests, paid))

function pct(n, d) {
  if (!d) return '(no paid orders)'
  return `(${((n / d) * 100).toFixed(1)}%)`
}

// Category coverage on the menu
const dishes = await prisma.dish.findMany({
  where: { deletedAt: null },
  select: { id: true, category: true, branchId: true },
})
const byCat = {}
let uncategorized = 0
for (const d of dishes) {
  if (!d.category) uncategorized++
  else byCat[d.category] = (byCat[d.category] || 0) + 1
}
console.log('\n=== DISH CATEGORIES ===')
console.log('total dishes:', dishes.length, '| uncategorized:', uncategorized)
for (const [cat, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cat}: ${n}`)
}

// What actually sells, by category
const items = await prisma.orderItem.findMany({
  where: { deletedAt: null, status: 'ACTIVE', order: { paidAt: { not: null } } },
  select: { orderId: true, dish: { select: { category: true } } },
})
const soldByCat = {}
for (const it of items) {
  const c = it.dish?.category || '(none)'
  soldByCat[c] = (soldByCat[c] || 0) + 1
}
console.log('\n=== SOLD LINE-ITEMS BY CATEGORY (paid orders) ===')
console.log('total line items:', items.length)
for (const [cat, n] of Object.entries(soldByCat).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cat}: ${n} ${pct(n, items.length)}`)
}

// Attachment-rate dry run: how many paid checks contain an Add-on / Dessert
const checks = new Map()
for (const it of items) {
  const c = it.dish?.category || '(none)'
  if (!checks.has(it.orderId)) checks.set(it.orderId, new Set())
  checks.get(it.orderId).add(c)
}
let withAddon = 0
let withDessert = 0
for (const cats of checks.values()) {
  if (cats.has('Add-ons')) withAddon++
  if (cats.has('Desserts')) withDessert++
}
console.log('\n=== ATTACHMENT DRY RUN ===')
console.log('paid checks with line items:', checks.size)
console.log('  contain an Add-on:', withAddon, pct(withAddon, checks.size))
console.log('  contain a Dessert:', withDessert, pct(withDessert, checks.size))

await prisma.$disconnect()
