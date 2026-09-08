// Applies the rooms migration to the local dev.db by hand.
//
// dev.db has drifted far from prisma/migrations — 17 recorded rows against 31
// files on disk, several rolled back, and a staff-wage migration that half
// applied — so `migrate deploy` cannot walk the history. This applies only the
// rooms change, idempotently, and touches nothing else in the database.
import pkg from '@prisma/client'
const { PrismaClient } = pkg
const p = new PrismaClient()

async function run(label, sql) {
  try {
    await p.$executeRawUnsafe(sql)
    console.log('  applied :', label)
  } catch (e) {
    const msg = String(e?.message || e)
    if (/duplicate column name|already exists/i.test(msg)) console.log('  present :', label)
    else throw e
  }
}

await run('restaurants.hotelEnabled', 'ALTER TABLE "restaurants" ADD COLUMN "hotelEnabled" BOOLEAN NOT NULL DEFAULT false')
await run('rooms table', `CREATE TABLE IF NOT EXISTS "rooms" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "restaurantId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'double',
  "capacity" INTEGER NOT NULL DEFAULT 2,
  "rate" REAL NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'vacant',
  "floor" TEXT,
  "notes" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  "deletedAt" DATETIME,
  CONSTRAINT "rooms_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`)
await run('rooms name index', 'CREATE UNIQUE INDEX IF NOT EXISTS "rooms_restaurantId_name_key" ON "rooms"("restaurantId", "name")')
await run('rooms branch index', 'CREATE INDEX IF NOT EXISTS "rooms_restaurantId_branchId_idx" ON "rooms"("restaurantId", "branchId")')

const check = await p.$queryRawUnsafe("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='rooms'")
console.log('rooms table present:', Number(check[0].n) === 1)
await p.$disconnect()
