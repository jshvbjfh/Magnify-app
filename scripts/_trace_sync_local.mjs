import { PrismaClient } from '@prisma/client'

const dbPath = 'C:/Users/HP/AppData/Roaming/restaurant-app/data/dev.db'
const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } })

const targetUrl = 'https://magnify-app-tau.vercel.app'
const email = 'high5ive@management.com'
const password = '50000000'
const deviceId = 'branch-device-c631c80b619d14eb40f4a75f'

const restaurant = await prisma.restaurant.findFirst({ where: { name: 'High 5ive' } })
console.log('1. Local restaurant:', { id: restaurant.id, joinCode: restaurant.joinCode, syncRestaurantId: restaurant.syncRestaurantId })

const branch = await prisma.branch.findFirst({ where: { restaurantId: restaurant.id, isMain: true } })
console.log('2. Main branch:', branch?.id)

// Local outbox rows pending push (should be empty on a freshly seeded device)
const outboxCount = await prisma.syncOutbox.count()
console.log('3. Local outbox row count (pending push):', outboxCount)

// Local sync cursors
const cursors = await prisma.syncCursor.findMany()
console.log('4. Local sync cursors:', cursors)

const pullCursors = cursors
  .filter(c => ['cmqia7buf0003n5p19gkoov3k', 'global'].includes(c.scopeId))
  .map(c => ({ scopeId: c.scopeId, target: c.target, lastPulledAt: c.lastPulledAt?.toISOString() ?? null }))
console.log('5. pullCursors being sent:', pullCursors)

const body = {
  joinCode: restaurant.joinCode,
  batchId: 'trace-batch-001',
  payloadHash: 'trace-hash-001',
  deviceId,
  branchId: branch?.id ?? null,
  branchIdentity: branch ? { id: branch.id, code: branch.code, name: branch.name, isMain: branch.isMain } : null,
  changes: [],
  pullCursors,
}
console.log('6. Full outbound body:', JSON.stringify(body, null, 2))

const res = await fetch(`${targetUrl}/api/sync`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-sync-email': email,
    'x-sync-password': password,
  },
  body: JSON.stringify(body),
})

console.log('7. Response status:', res.status)
const payload = await res.json().catch(() => null)
console.log('8. pullChanges count:', payload?.pullChanges?.length)
console.log('9. message:', payload?.message)
if (!payload?.ok) console.log('FULL ERROR PAYLOAD:', JSON.stringify(payload, null, 2))

await prisma.$disconnect()
