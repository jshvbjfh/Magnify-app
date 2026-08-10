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

const restaurantId = 'cmqia7buf0003n5p19gkoov3k'

const actualDishes = await prisma.dish.findMany({ where: { restaurantId }, select: { id: true } })
const outboxDishRows = await prisma.syncOutbox.findMany({ where: { scopeId: restaurantId, entityType: 'dish' }, select: { entityId: true } })
const outboxDishIds = new Set(outboxDishRows.map(r => r.entityId))

const actualInv = await prisma.inventoryItem.findMany({ where: { restaurantId }, select: { id: true } })
const outboxInvRows = await prisma.syncOutbox.findMany({ where: { scopeId: restaurantId, entityType: 'inventoryItem' }, select: { entityId: true } })
const outboxInvIds = new Set(outboxInvRows.map(r => r.entityId))

const dishesWithoutOutbox = actualDishes.filter(d => !outboxDishIds.has(d.id))
const invWithoutOutbox = actualInv.filter(d => !outboxInvIds.has(d.id))

console.log('Total actual dishes:', actualDishes.length)
console.log('Distinct dish IDs with ANY outbox row:', outboxDishIds.size)
console.log('Dishes with ZERO outbox history (invisible to sync):', dishesWithoutOutbox.length)
console.log('---')
console.log('Total actual inventory items:', actualInv.length)
console.log('Distinct inventory IDs with ANY outbox row:', outboxInvIds.size)
console.log('Inventory items with ZERO outbox history (invisible to sync):', invWithoutOutbox.length)

await prisma.$disconnect()
