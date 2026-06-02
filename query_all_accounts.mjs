import { PrismaClient } from '@prisma/client'
const prisma = new PrismaClient()

async function main() {
  const restaurantId = 'cmpfkza9u0003wwig4znjkpo9'
  const accounts = await prisma.account.findMany({
    where: {
      restaurantId: restaurantId,
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
