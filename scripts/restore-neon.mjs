// Restoration script for chez john2 restaurant in Neon
// Run: node scripts/restore-neon.mjs

import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: 'postgresql://neondb_owner:npg_HOhoknKCjp09@ep-empty-queen-abmaykbe.eu-west-2.aws.neon.tech/neondb?sslmode=require&connect_timeout=30'
    }
  }
})

// ─── Known Neon cloud IDs (from previous diagnostic + conversation context) ───
const RESTAURANT_ID      = 'cmoclcvse0002fqyclnwcxhmw'
const OWNER_NEON_ID      = 'cmoco8mrx0001d1mo8dkly9yy'   // chezjohn2owner@gmail.com
const BRANCH_MAIN_ID     = 'cmoclcy030004fqycq298t6fh'
const BRANCH_COFFEE_ID   = 'cmocp93n702vgfqyczxqz5pr0'
const BRANCH_BBQ_ID      = 'cmocpbfgm02zofqycq94wqgub'

// ─── From local Electron SQLite DB ─────────────────────────────────────────────
const SYNC_RESTAURANT_ID = 'branch_b00fae69cb3529d7f390'
const SYNC_TOKEN         = '8901836b76901adba87f407ca6cc99472e119cd46834889c'

// ─── Existing Neon users with null restaurantId ────────────────────────────────
const USER_BOBOLO   = 'cmocpdnze0001k1686ocnd6qs'  // bobolo@gmail.com  branchId=COFFEE
const USER_POPOLO   = 'cmocq3gmp0001esncxytgnb4u'  // popolo@gmail.com  branchId=COFFEE
const USER_DODOLO   = 'cmocq5wjs00032ew5j2acm8cv'  // dodolo@gmail.com  branchId=COFFEE

async function main() {
  console.log('=== Starting Neon restoration for chez john2 ===\n')

  // 1. Verify the owner user exists
  const owner = await prisma.user.findUnique({ where: { id: OWNER_NEON_ID } })
  if (!owner) {
    throw new Error(`Owner user ${OWNER_NEON_ID} not found in Neon! Aborting.`)
  }
  console.log(`✓ Owner found: ${owner.email} (role: ${owner.role})`)

  // 2. Check if restaurant already exists (idempotent)
  const existing = await prisma.restaurant.findUnique({ where: { id: RESTAURANT_ID } })
  if (existing) {
    console.log('⚠ Restaurant already exists — skipping creation')
  } else {
    await prisma.restaurant.create({
      data: {
        id:               RESTAURANT_ID,
        name:             'chez john2',
        ownerId:          OWNER_NEON_ID,
        joinCode:         'CHZJN2',           // 6-char join code
        syncRestaurantId: SYNC_RESTAURANT_ID,
        syncToken:        SYNC_TOKEN,
        billHeader:       '',
        qrOrderingMode:   'order',
        fifoEnabled:      false,
        licenseActive:    true,
      }
    })
    console.log(`✓ Restaurant created: ${RESTAURANT_ID}`)
  }

  // 3. Create branches (upsert so safe to re-run)
  const branches = [
    { id: BRANCH_MAIN_ID,   name: 'Main',   code: 'MAIN',   isMain: true,  sortOrder: 0 },
    { id: BRANCH_COFFEE_ID, name: 'Coffee', code: 'COFFEE', isMain: false, sortOrder: 1 },
    { id: BRANCH_BBQ_ID,    name: 'BBQ',    code: 'BBQ',    isMain: false, sortOrder: 2 },
  ]
  for (const branch of branches) {
    const existing = await prisma.restaurantBranch.findUnique({ where: { id: branch.id } })
    if (existing) {
      console.log(`⚠ Branch ${branch.name} (${branch.id}) already exists — skipping`)
    } else {
      await prisma.restaurantBranch.create({
        data: {
          id:           branch.id,
          restaurantId: RESTAURANT_ID,
          name:         branch.name,
          code:         branch.code,
          isMain:       branch.isMain,
          isActive:     true,
          sortOrder:    branch.sortOrder,
        }
      })
      console.log(`✓ Branch created: ${branch.name} (${branch.id})`)
    }
  }

  // 4. Link owner to restaurant (update restaurantId)
  await prisma.user.update({
    where: { id: OWNER_NEON_ID },
    data: { restaurantId: RESTAURANT_ID }
  })
  console.log(`✓ Owner linked to restaurant`)

  // 5. Link existing waiters to restaurant
  for (const userId of [USER_BOBOLO, USER_POPOLO, USER_DODOLO]) {
    await prisma.user.update({
      where: { id: userId },
      data: { restaurantId: RESTAURANT_ID }
    })
  }
  console.log(`✓ Waiters (bobolo/popolo/dodolo) linked to restaurant`)

  // 6. Recreate meepmeep@gmail.com
  const meepmeep = await prisma.user.findUnique({ where: { email: 'meepmeep@gmail.com' } })
  if (meepmeep) {
    console.log('⚠ meepmeep@gmail.com already exists — skipping')
  } else {
    const hash = await bcrypt.hash('hello@123', 12)
    await prisma.user.create({
      data: {
        email:        'meepmeep@gmail.com',
        password:     hash,
        role:         'waiter',
        restaurantId: RESTAURANT_ID,
        branchId:     BRANCH_MAIN_ID,
        isActive:     true,
      }
    })
    console.log('✓ meepmeep@gmail.com recreated')
  }

  // 7. Verify final state
  console.log('\n=== Final Neon state ===')
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: RESTAURANT_ID },
    include: { branches: true, waiters: { select: { id: true, email: true, role: true, branchId: true } } }
  })
  console.log('Restaurant:', restaurant?.name, '|', restaurant?.id)
  console.log('Branches:', restaurant?.branches.map(b => `${b.name}(${b.code})`).join(', '))
  console.log('Users:', restaurant?.waiters.map(u => `${u.email}[${u.role}]`).join(', '))

  console.log('\n✅ Restoration complete')
}

main()
  .catch(err => { console.error('FAILED:', err); process.exit(1) })
  .finally(() => prisma.$disconnect())
