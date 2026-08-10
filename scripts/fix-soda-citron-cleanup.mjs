/**
 * Parking Bar cleanup (2026-07-14):
 *  - Soda Citron: the manager deleted it on their portal but the delete pushed
 *    a device-local id the cloud never had, so the cloud copy kept coming
 *    back. Soft-delete + deactivate the CLOUD row and broadcast the delete.
 *  - Fanta: soft-deleted 7/1 but isActive=true leaked it into every pull.
 *    Deactivate so it vanishes from tills even before the pull fix deploys.
 *  - SODA (the manager's new consolidated drink): give it the Soft Drinks
 *    category (was uncategorised).
 */
import { createRequire } from 'module'
import { resolve } from 'path'
import { readFileSync } from 'fs'
import { randomUUID } from 'crypto'
for (const file of ['.env.local', '.env']) {
  try {
    for (const line of readFileSync(resolve(process.cwd(), file), 'utf8').split('\n')) {
      const t = line.trim(); if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('='); if (eq < 0) continue
      const k = t.slice(0, eq).trim(), v = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
      if (!process.env[k]) process.env[k] = v
    }
  } catch {}
}
const require = createRequire(import.meta.url)
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })

const REST = 'cmqia7buf0003n5p19gkoov3k'
const PARKING = 'cmqiagbtb0010n5p1utvhc8s6'
const CITRON = 'cmr1wflaw0005uq3jkr8un76i'
const FANTA = 'cmqqhr0zo000pcnq3xwxl9jf6'
const SODA = 'cmrkrl2og004l12s2ggbncv8n'

const outbox = (entityId, operation, payload) => prisma.syncOutbox.create({
  data: {
    scopeId: REST, restaurantId: REST, branchId: PARKING,
    entityType: 'dish', entityId, operation,
    payload: JSON.stringify(payload),
    mutationId: randomUUID(), sourceDeviceId: 'cloud', availableAt: new Date(),
  },
})

const citron = await prisma.dish.update({
  where: { id: CITRON },
  data: { deletedAt: new Date(), isActive: false },
})
await outbox(CITRON, 'delete', { id: CITRON })
console.log(`Soda Citron: soft-deleted + deactivated (${citron.name})`)

const fanta = await prisma.dish.update({
  where: { id: FANTA },
  data: { isActive: false },
})
await outbox(FANTA, 'delete', { id: FANTA })
console.log(`Fanta: deactivated (was deleted ${fanta.deletedAt?.toISOString()}, but leaking via isActive)`)

const soda = await prisma.dish.update({
  where: { id: SODA },
  data: { category: 'Soft Drinks' },
})
await outbox(SODA, 'upsert', soda)
console.log(`SODA: category set to Soft Drinks`)

await prisma.$disconnect()
console.log('Done.')
