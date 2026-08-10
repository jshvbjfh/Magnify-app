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

console.log('=== ISSUE 1: latest sale ===')
const latestSale = await prisma.dishSale.findFirst({
  where: { restaurantId },
  orderBy: { createdAt: 'desc' },
})
console.log('Latest DishSale:', JSON.stringify(latestSale, null, 2))

const latestOutboxForSale = await prisma.syncOutbox.findFirst({
  where: { scopeId: restaurantId, entityType: 'dishSale' },
  orderBy: { createdAt: 'desc' },
})
console.log('\nLatest dishSale outbox row:', JSON.stringify(latestOutboxForSale, null, 2))

console.log('\n=== ISSUE 2: WHATABURGER dishes ===')
const whataburgerBranch = await prisma.branch.findFirst({ where: { restaurantId, name: 'WHATABURGER' } })
console.log('WHATABURGER branch id:', whataburgerBranch?.id)

const whataburgerDishes = await prisma.dish.findMany({
  where: { restaurantId, branchId: whataburgerBranch.id },
  select: { id: true, name: true, category: true, menuType: true, sellingPrice: true, createdAt: true, updatedAt: true },
  orderBy: { createdAt: 'asc' },
})
console.log('Postgres WHATABURGER dish count:', whataburgerDishes.length)
console.log(JSON.stringify(whataburgerDishes, null, 2))

await prisma.$disconnect()
