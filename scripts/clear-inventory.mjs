import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

const r = await prisma.inventoryItem.deleteMany()
console.log(`Deleted ${r.count} inventory items.`)
await prisma.$disconnect()
