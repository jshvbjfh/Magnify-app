import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

const t  = await prisma.transaction.deleteMany({})
const ds = await prisma.dishSale.deleteMany({})
const po = await prisma.pendingOrder.deleteMany({})

console.log('Deleted', t.count,  'transactions')
console.log('Deleted', ds.count, 'dish sales')
console.log('Deleted', po.count, 'pending orders')

await prisma.$disconnect()
