// Seeds Le Petit Chalet's Main Course menu on the Kitchen station.
//
// Raw SQL rather than the Prisma client on purpose: the generated client is on
// the feat/rra-ebm-v1.1.50 schema (itemType, taxCategory, itemCode …) and the
// live database has not had that migration deployed, so dish.upsert() fails
// P2022 on a column that does not exist there yet. The INSERT below names only
// the columns the live table actually has.
//
// Mirrors app/api/restaurant/dishes/route.ts POST: write the dish, then enqueue
// a sync outbox row so local-first desktop instances hear about it. Waiter apps
// pull dishes straight from the table (app/api/mobile/pull), so they get these
// either way. ON CONFLICT keeps the script re-runnable.
import { PrismaClient } from '@prisma/client'
import { randomUUID, randomBytes } from 'node:crypto'
import fs from 'node:fs'

function readEnvVar(file, key) {
  const content = fs.readFileSync(file, 'utf8')
  const line = content.split('\n').find(l => l.startsWith(`${key}=`))
  if (!line) return null
  return line.slice(key.length + 1).trim().replace(/^"|"$/g, '')
}

// Prisma's @default(cuid()) shape — 'c' + 24 base36 chars — so these ids look
// like every other id in the table rather than a UUID nobody else uses.
let cuidCounter = Math.floor(Math.random() * 1e6)
function cuid() {
  const time = Date.now().toString(36)
  const counter = (cuidCounter++ % 1679616).toString(36).padStart(4, '0')
  const random = randomBytes(8).toString('hex').replace(/[^0-9a-z]/g, '')
  return ('c' + time + counter + random).slice(0, 25).padEnd(25, '0')
}

const url = readEnvVar('.env.local', 'DATABASE_URL')
const prisma = new PrismaClient({ datasources: { db: { url } } })

const RESTAURANT_ID = 'cmtpkuwlg0002qdoaywyapna5' // Le Petit Chalet
const BRANCH_ID = 'cmtpl6s0s0002s6ajxtu01cr5'     // Kitchen station
const CATEGORY = 'Main Course'
const MENU_TYPE = 'mains'

const DISHES = [
  { name: 'Steak Frites', sellingPrice: 39000 },
  { name: 'Braised Lamb Shank', sellingPrice: 36000 },
  { name: 'Tilapia', sellingPrice: 29000 },
  { name: 'Chicken Rigatoni alla Vodka', sellingPrice: 30000 },
]

const DRY_RUN = process.argv.includes('--dry-run')

const [restaurant] = await prisma.$queryRawUnsafe(
  `SELECT name FROM restaurants WHERE id = $1`, RESTAURANT_ID)
const [branch] = await prisma.$queryRawUnsafe(
  `SELECT name, "restaurantId" FROM branches WHERE id = $1`, BRANCH_ID)
if (!restaurant) throw new Error('restaurant not found')
if (!branch || branch.restaurantId !== RESTAURANT_ID) throw new Error('branch not found on this restaurant')
console.log(`Target: ${restaurant.name} / ${branch.name} station${DRY_RUN ? '  (DRY RUN)' : ''}`)

for (const item of DISHES) {
  if (DRY_RUN) {
    const [existing] = await prisma.$queryRawUnsafe(
      `SELECT id FROM dishes WHERE "restaurantId" = $1 AND "branchId" = $2 AND name = $3`,
      RESTAURANT_ID, BRANCH_ID, item.name)
    console.log(`  ${existing ? 'would update' : 'would create'}  ${item.name} — ${item.sellingPrice}`)
    continue
  }

  await prisma.$transaction(async (tx) => {
    const [dish] = await tx.$queryRawUnsafe(
      `INSERT INTO dishes (id, "restaurantId", "branchId", name, "sellingPrice", category, "menuType", "isActive", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, NOW(), NOW())
       ON CONFLICT ("restaurantId", "branchId", name) DO UPDATE
         SET "sellingPrice" = EXCLUDED."sellingPrice",
             category       = EXCLUDED.category,
             "menuType"     = EXCLUDED."menuType",
             "isActive"     = true,
             "deletedAt"    = NULL,
             "updatedAt"    = NOW()
       RETURNING *`,
      cuid(), RESTAURANT_ID, BRANCH_ID, item.name, item.sellingPrice, CATEGORY, MENU_TYPE)

    await tx.$executeRawUnsafe(
      `INSERT INTO sync_outbox (id, "scopeId", "restaurantId", "branchId", "entityType", "entityId", operation, payload, "mutationId", "sourceDeviceId", "availableAt", "createdAt", "updatedAt")
       VALUES ($1, $2, $2, $3, 'dish', $4, 'upsert', $5, $6, 'cloud', NOW(), NOW(), NOW())`,
      cuid(), RESTAURANT_ID, BRANCH_ID, dish.id, JSON.stringify(dish), randomUUID())

    console.log(`  ok  ${dish.name.padEnd(30)} ${dish.sellingPrice}  ${dish.id}`)
  })
}

const final = await prisma.$queryRawUnsafe(
  `SELECT name, category, "menuType", "sellingPrice", "isActive" FROM dishes
   WHERE "restaurantId" = $1 AND "deletedAt" IS NULL ORDER BY "sellingPrice" DESC`, RESTAURANT_ID)
console.log('\n--- Le Petit Chalet menu now ---')
console.table(final)

await prisma.$disconnect()
