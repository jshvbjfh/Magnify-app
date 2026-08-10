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

const email = 'high5ive@management.com'
const user = await prisma.user.findUnique({ where: { email } })
const restaurant = await prisma.restaurant.findFirst({ where: { ownerId: user.id } })
const branches = await prisma.branch.findMany({ where: { restaurantId: restaurant.id } })
const staff = await prisma.staff.findMany({ where: { restaurantId: restaurant.id } })
const staffBranches = await prisma.staffBranch.findMany({ where: { staffId: { in: staff.map(s => s.id) } } })

const dump = { user, restaurant, branches, staff, staffBranches }
fs.writeFileSync('scripts/_high5ive_dump.json', JSON.stringify(dump, null, 2))
console.log('Dumped:', {
  user: !!user,
  restaurant: !!restaurant,
  branches: branches.length,
  staff: staff.length,
  staffBranches: staffBranches.length,
})

await prisma.$disconnect()
