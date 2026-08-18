// Read-only report on the SIROCCO Y SOL account. No writes of any kind.
// The root .env points DATABASE_URL at the SQLite dev.db and @prisma/client
// loads it on import, so .env.local must be parsed AND forced to override,
// with the client imported dynamically afterwards.
import fs from 'fs'

const env = {}
for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/)
  if (m) env[m[1]] = m[2]
}
for (const k of ['DATABASE_URL', 'DIRECT_URL']) if (env[k]) process.env[k] = env[k]

const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
console.log('DB host:', (process.env.DATABASE_URL || '').match(/@([^/:?]+)/)?.[1] ?? '(none)', '\n')

const rows = await p.restaurant.findMany({
  where: { name: { contains: 'rocco', mode: 'insensitive' } },
  select: {
    id: true, name: true, joinCode: true, createdAt: true, deletedAt: true,
    licenseActive: true, licenseExpiry: true, sharedStock: true,
    qrOrderingMode: true, billPrinterIp: true,
    owner: { select: { email: true, role: true, isActive: true } },
    branches: { select: { id: true, name: true, type: true, deletedAt: true }, orderBy: { createdAt: 'asc' } },
    _count: { select: { staff: true, categories: true, shifts: true } },
  },
})

if (!rows.length) {
  console.log('No restaurant matching "rocco".')
  const recent = await p.restaurant.findMany({
    where: { createdAt: { gte: new Date(Date.now() - 3 * 24 * 3600 * 1000) } },
    select: { name: true, createdAt: true, owner: { select: { email: true } } },
    orderBy: { createdAt: 'desc' },
    take: 10,
  })
  console.log('Created in the last 3 days:\n' + JSON.stringify(recent, null, 2))
} else {
  for (const r of rows) {
    console.log(JSON.stringify(r, null, 2))
    const [dishes, orders] = await Promise.all([
      p.dish.count({ where: { branch: { restaurantId: r.id } } }),
      p.restaurantOrder.count({ where: { branch: { restaurantId: r.id } } }),
    ])
    console.log(`dishes: ${dishes}   orders: ${orders}\n`)
  }
}

await p.$disconnect()
