import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
  const restaurantId = 'cmpfkza9u0003wwig4znjkpo9'
  const accounts = await prisma.account.findMany({
    where: {
      restaurantId: restaurantId,
      OR: [
        { name: { contains: 'sale', mode: 'insensitive' } },
        { name: { contains: 'revenue', mode: 'insensitive' } },
        { name: { contains: 'inventory', mode: 'insensitive' } },
        { name: { contains: 'purchase', mode: 'insensitive' } },
        { code: { contains: 'sale', mode: 'insensitive' } },
        { code: { contains: 'revenue', mode: 'insensitive' } },
        { code: { contains: 'inventory', mode: 'insensitive' } },
        { code: { contains: 'purchase', mode: 'insensitive' } },
        { name: { contains: 'dish', mode: 'insensitive' } }
      ]
    },
    include: {
      category: true
    }
  })

  console.log(JSON.stringify(accounts, null, 2))
}

main()
  .catch(e => console.error(e))
  .finally(() => prisma.$disconnect())
