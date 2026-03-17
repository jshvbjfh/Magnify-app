import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()
const rows = await prisma.dish.groupBy({
  by: ['category'],
  where: { user: { email: 'gboy@gmail.com' } },
  _count: true,
  orderBy: { category: 'asc' },
})
let total = 0
rows.forEach(r => { console.log(`  ${r.category ?? 'Uncategorised'}: ${r._count} dishes`); total += r._count })
console.log(`\n  TOTAL: ${total} dishes`)
await prisma.$disconnect()
