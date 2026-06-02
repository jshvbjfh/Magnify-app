import { PrismaClient } from '@prisma/client'
const p = new PrismaClient()
const u = await p.user.findUnique({
  where: { email: 'testmanager@magnify.test' },
  select: { id: true, email: true, role: true, isActive: true }
})
console.log(u ? JSON.stringify(u, null, 2) : 'NOT FOUND in Neon')
await p.$disconnect()
