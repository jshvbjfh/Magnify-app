import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const rows = await db.$queryRawUnsafe('SELECT name FROM sqlite_master WHERE type="table" ORDER BY name')
console.log(rows.map(r => r.name).join('\n'))
await db.$disconnect()
