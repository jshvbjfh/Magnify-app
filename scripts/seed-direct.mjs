/**
 * Seed script using Prisma directly (no HTTP layer).
 * Creates 4 branches + 25 menu items for the test restaurant.
 * Run: node scripts/seed-direct.mjs
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const RESTAURANT_ID = 'cmpi2f0ng0003s5rguazrgruy'
const MAIN_BRANCH_ID = 'cmpi2f2zg0005s5rgizfqlqxn'
const USER_ID = 'cmpi2ey0m0001s5rgv19fq590'

const log = msg => console.log(`[${new Date().toISOString()}] ${msg}`)

// ── Branches ──────────────────────────────────────────────────────────────────

const BRANCHES = [
  { name: 'Main Branch', code: 'MAIN', isMain: true, address: 'City Center' },
  { name: 'Downtown', code: 'DT', isMain: false, address: '5 Downtown Ave' },
  { name: 'Airport', code: 'APT', isMain: false, address: 'International Airport Terminal 2' },
  { name: 'Mall', code: 'MALL', isMain: false, address: 'Shopping Mall, Level 1' },
]

async function seedBranches() {
  log('=== Seeding Branches ===')
  const existing = await prisma.branch.findMany({ where: { restaurantId: RESTAURANT_ID } })
  const existingCodes = new Set(existing.map(b => b.code))
  log(`Existing branches: ${existing.length} (${[...existingCodes].join(', ') || 'none'})`)

  for (const b of BRANCHES) {
    if (existingCodes.has(b.code)) {
      log(`Skip: "${b.name}" (${b.code}) already exists`)
      continue
    }
    const created = await prisma.branch.create({
      data: {
        restaurantId: RESTAURANT_ID,
        name: b.name,
        code: b.code,
        isMain: b.isMain,
        ...(b.address ? { address: b.address } : {}),
      },
    })
    log(`Created branch: "${b.name}" (${b.code}) → ${created.id}`)
  }
}

// ── Menu items ────────────────────────────────────────────────────────────────

const MENU = [
  // Pizzas
  { name: 'Margherita Pizza', category: 'Pizza', sellingPrice: 12000 },
  { name: 'Pepperoni Pizza', category: 'Pizza', sellingPrice: 14000 },
  { name: 'BBQ Chicken Pizza', category: 'Pizza', sellingPrice: 15000 },
  { name: 'Vegetarian Pizza', category: 'Pizza', sellingPrice: 13000 },
  { name: 'Four Cheese Pizza', category: 'Pizza', sellingPrice: 16000 },

  // Salads
  { name: 'Caesar Salad', category: 'Salads', sellingPrice: 6500 },
  { name: 'Greek Salad', category: 'Salads', sellingPrice: 6000 },
  { name: 'Coleslaw', category: 'Salads', sellingPrice: 3500 },
  { name: 'Garden Salad', category: 'Salads', sellingPrice: 5000 },

  // Mains
  { name: 'Grilled Chicken', category: 'Mains', sellingPrice: 11000 },
  { name: 'Beef Burger', category: 'Mains', sellingPrice: 9500 },
  { name: 'Fish & Chips', category: 'Mains', sellingPrice: 10000 },
  { name: 'Pasta Carbonara', category: 'Mains', sellingPrice: 9000 },
  { name: 'Chicken Wings', category: 'Mains', sellingPrice: 8500 },

  // Sides
  { name: 'French Fries', category: 'Sides', sellingPrice: 3000 },
  { name: 'Onion Rings', category: 'Sides', sellingPrice: 3500 },
  { name: 'Garlic Bread', category: 'Sides', sellingPrice: 2500 },

  // Beer
  { name: 'Heineken 330ml', category: 'Beer', sellingPrice: 2500 },
  { name: 'Guinness 500ml', category: 'Beer', sellingPrice: 3500 },
  { name: 'Corona 330ml', category: 'Beer', sellingPrice: 2800 },
  { name: 'Local Draft Beer', category: 'Beer', sellingPrice: 1500 },

  // Spirits
  { name: 'Whiskey Single', category: 'Spirits', sellingPrice: 4500 },
  { name: 'Vodka Tonic', category: 'Spirits', sellingPrice: 3800 },
  { name: 'Rum & Coke', category: 'Spirits', sellingPrice: 3500 },

  // Soft Drinks
  { name: 'Soda Coke/Fanta/Sprite', category: 'Drinks', sellingPrice: 1000 },
]

async function seedMenu() {
  log('=== Seeding Menu ===')
  const existing = await prisma.dish.findMany({
    where: { restaurantId: RESTAURANT_ID, deletedAt: null },
    select: { name: true },
  })
  const existingNames = new Set(existing.map(d => d.name))
  log(`Existing dishes: ${existingNames.size}`)

  let created = 0
  let skipped = 0
  for (const item of MENU) {
    if (existingNames.has(item.name)) {
      log(`Skip: "${item.name}"`)
      skipped++
      continue
    }
    await prisma.dish.create({
      data: {
        restaurantId: RESTAURANT_ID,
        branchId: MAIN_BRANCH_ID,
        name: item.name,
        category: item.category,
        sellingPrice: item.sellingPrice,
        menuType: 'food',
      },
    })
    log(`Created: "${item.name}" (${item.category}) — ${item.sellingPrice.toLocaleString()}`)
    created++
  }
  log(`Menu done: ${created} created, ${skipped} skipped`)
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log('=== Direct Prisma Seed ===')
  try {
    await seedBranches()
    await seedMenu()
    log('\n=== All done! ===')
  } finally {
    await prisma.$disconnect()
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1) })
