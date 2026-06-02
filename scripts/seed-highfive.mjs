/**
 * Seed: High 5ive bar and grill
 * Creates owner account, restaurant, 5 branches, and dishes (≥5 per branch).
 * Run: node scripts/seed-highfive.mjs
 */

import { createRequire } from 'module'
import { resolve } from 'path'
import { readFileSync } from 'fs'

// Load .env manually
for (const file of ['.env.local', '.env']) {
  try {
    const lines = readFileSync(resolve(process.cwd(), file), 'utf8').split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq < 0) continue
      const key = trimmed.slice(0, eq).trim()
      const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
      if (!process.env[key]) process.env[key] = val
    }
  } catch { /* ignore missing */ }
}

const require = createRequire(import.meta.url)
const bcrypt = require('bcryptjs')
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })
const log = msg => console.log(`  ${msg}`)

// ─── Config ────────────────────────────────────────────────────────────────────

const OWNER_EMAIL    = 'highfive@magnify.test'
const OWNER_PASSWORD = 'hello@123'
const OWNER_NAME     = 'High 5ive Manager'
const RESTAURANT     = 'High 5ive bar and grill'
const JOIN_CODE      = 'HIGH5IVE'

const BRANCHES = [
  { name: 'Downtown Grill',    code: 'DT',  isMain: true  },
  { name: 'Uptown Bar',        code: 'UB',  isMain: false },
  { name: 'Westside Kitchen',  code: 'WK',  isMain: false },
  { name: 'Eastside Lounge',   code: 'EL',  isMain: false },
  { name: 'Northgate Patio',   code: 'NGP', isMain: false },
]

// Dishes per branch — each branch gets its own rows (branch-scoped in this app).
const BRANCH_DISHES = {
  'Downtown Grill': [
    { name: 'Margherita Pizza (Family)',    category: 'Pizza',   sellingPrice: 4500, menuType: 'food' },
    { name: 'Margherita Pizza (Regular)',   category: 'Pizza',   sellingPrice: 2800, menuType: 'food' },
    { name: 'BBQ Chicken Pizza (Family)',   category: 'Pizza',   sellingPrice: 5200, menuType: 'food' },
    { name: 'Classic Beef Burger (Big)',    category: 'Burgers', sellingPrice: 3800, menuType: 'food' },
    { name: 'BBQ Beef Ribs',               category: 'Grills',  sellingPrice: 6500, menuType: 'food' },
    { name: 'Chocolate Milkshake',         category: 'Drinks',  sellingPrice: 1800, menuType: 'drink' },
    { name: 'Fresh Orange Juice',          category: 'Drinks',  sellingPrice: 1200, menuType: 'drink' },
    { name: 'Heineken Beer',               category: 'Drinks',  sellingPrice: 2500, menuType: 'drink' },
  ],
  'Uptown Bar': [
    { name: 'Mojito',                      category: 'Drinks',  sellingPrice: 2500, menuType: 'drink' },
    { name: 'Virgin Mojito',               category: 'Drinks',  sellingPrice: 1800, menuType: 'drink' },
    { name: 'Strawberry Milkshake',        category: 'Drinks',  sellingPrice: 1800, menuType: 'drink' },
    { name: "Jack Daniel's Whiskey",       category: 'Drinks',  sellingPrice: 4000, menuType: 'drink' },
    { name: 'Amarula Cream',               category: 'Drinks',  sellingPrice: 3500, menuType: 'drink' },
    { name: 'Mixed Grill Platter',         category: 'Grills',  sellingPrice: 8000, menuType: 'food' },
    { name: 'Grilled T-Bone Steak',        category: 'Grills',  sellingPrice: 9500, menuType: 'food' },
    { name: 'BBQ Chicken Wings',           category: 'Grills',  sellingPrice: 4500, menuType: 'food' },
  ],
  'Westside Kitchen': [
    { name: 'Classic Beef Burger (Regular)', category: 'Burgers', sellingPrice: 3000, menuType: 'food' },
    { name: 'Classic Beef Burger (Small)',   category: 'Burgers', sellingPrice: 2000, menuType: 'food' },
    { name: 'Chicken Burger (Regular)',      category: 'Burgers', sellingPrice: 2800, menuType: 'food' },
    { name: 'Cheese Burger (Big)',           category: 'Burgers', sellingPrice: 3500, menuType: 'food' },
    { name: 'Double Smash Burger',           category: 'Burgers', sellingPrice: 4500, menuType: 'food' },
    { name: 'Pepperoni Pizza (Regular)',     category: 'Pizza',   sellingPrice: 3200, menuType: 'food' },
    { name: 'Veggie Pizza (Small)',          category: 'Pizza',   sellingPrice: 2200, menuType: 'food' },
  ],
  'Eastside Lounge': [
    { name: 'Mango Juice',                 category: 'Drinks',  sellingPrice: 1200, menuType: 'drink' },
    { name: 'Watermelon Juice',            category: 'Drinks',  sellingPrice: 1200, menuType: 'drink' },
    { name: 'Passion Fruit Mojito',        category: 'Drinks',  sellingPrice: 2500, menuType: 'drink' },
    { name: 'Corona Beer',                 category: 'Drinks',  sellingPrice: 2200, menuType: 'drink' },
    { name: 'Grilled Prawn Skewers',       category: 'Grills',  sellingPrice: 7000, menuType: 'food' },
    { name: 'BBQ Pork Chops',             category: 'Grills',  sellingPrice: 5500, menuType: 'food' },
    { name: 'BBQ Lamb Chops',             category: 'Grills',  sellingPrice: 7500, menuType: 'food' },
  ],
  'Northgate Patio': [
    { name: 'Pepperoni Pizza (Family)',    category: 'Pizza',   sellingPrice: 4800, menuType: 'food' },
    { name: 'Chicken Burger (Big)',        category: 'Burgers', sellingPrice: 3500, menuType: 'food' },
    { name: 'BBQ Beef Ribs (Full Rack)',   category: 'Grills',  sellingPrice: 9000, menuType: 'food' },
    { name: 'Grilled T-Bone Steak',       category: 'Grills',  sellingPrice: 9500, menuType: 'food' },
    { name: 'Vanilla Milkshake',          category: 'Drinks',  sellingPrice: 1800, menuType: 'drink' },
    { name: 'Fresh Lemonade',             category: 'Drinks',  sellingPrice: 1500, menuType: 'drink' },
    { name: 'Single Malt Whiskey',        category: 'Drinks',  sellingPrice: 4500, menuType: 'drink' },
    { name: 'Pineapple Juice',            category: 'Drinks',  sellingPrice: 1200, menuType: 'drink' },
  ],
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🍖  Seeding High 5ive bar and grill\n')

  // 1. Owner user
  let user = await prisma.user.findUnique({ where: { email: OWNER_EMAIL } })
  if (user) {
    log(`User already exists: ${OWNER_EMAIL}`)
  } else {
    const hashed = bcrypt.hashSync(OWNER_PASSWORD, 10)
    user = await prisma.user.create({
      data: {
        email: OWNER_EMAIL,
        name: OWNER_NAME,
        password: hashed,
        role: 'owner',
        isActive: true,
      },
    })
    log(`Created user: ${OWNER_EMAIL}`)
  }

  // 2. Restaurant
  let restaurant = await prisma.restaurant.findFirst({
    where: { ownerId: user.id, name: RESTAURANT },
  })
  if (restaurant) {
    log(`Restaurant already exists: ${RESTAURANT}`)
  } else {
    // Make sure join code is unique
    const existingCode = await prisma.restaurant.findUnique({ where: { joinCode: JOIN_CODE } })
    const joinCode = existingCode ? `${JOIN_CODE}2` : JOIN_CODE
    restaurant = await prisma.restaurant.create({
      data: {
        name: RESTAURANT,
        ownerId: user.id,
        joinCode,
        qrOrderingMode: 'order',
        licenseActive: true,
        fifoEnabled: false,
      },
    })
    log(`Created restaurant: ${RESTAURANT} (joinCode: ${restaurant.joinCode})`)
  }

  // 3. Branches
  const branchMap = {}
  for (const b of BRANCHES) {
    let branch = await prisma.branch.findFirst({
      where: { restaurantId: restaurant.id, name: b.name },
    })
    if (!branch) {
      // Ensure code is unique within restaurant
      const existingCode = await prisma.branch.findFirst({
        where: { restaurantId: restaurant.id, code: b.code },
      })
      const code = existingCode ? `${b.code}2` : b.code
      branch = await prisma.branch.create({
        data: {
          restaurantId: restaurant.id,
          name: b.name,
          code,
          isMain: b.isMain,
          isActive: true,
        },
      })
      log(`Created branch: ${b.name} (${code})`)
    } else {
      log(`Branch already exists: ${b.name}`)
    }
    branchMap[b.name] = branch
  }

  // 4. Dishes per branch
  let totalDishes = 0
  for (const [branchName, dishes] of Object.entries(BRANCH_DISHES)) {
    const branch = branchMap[branchName]
    if (!branch) { log(`WARN: branch not found — ${branchName}`); continue }

    for (const d of dishes) {
      const exists = await prisma.dish.findFirst({
        where: { restaurantId: restaurant.id, branchId: branch.id, name: d.name, deletedAt: null },
      })
      if (exists) { log(`  Skip (exists): ${d.name} @ ${branchName}`); continue }

      await prisma.dish.create({
        data: {
          restaurantId: restaurant.id,
          branchId: branch.id,
          name: d.name,
          category: d.category,
          sellingPrice: d.sellingPrice,
          menuType: d.menuType,
          isActive: true,
        },
      })
      log(`  + ${d.name} (${d.category}) @ ${branchName} — ${d.sellingPrice.toLocaleString()}`)
      totalDishes++
    }
  }

  // ─── Summary ─────────────────────────────────────────────────────────────────
  const branchCount = Object.keys(branchMap).length
  const dishCount = await prisma.dish.count({ where: { restaurantId: restaurant.id, deletedAt: null } })
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Restaurant : ${RESTAURANT}
  Owner      : ${OWNER_EMAIL}
  Password   : ${OWNER_PASSWORD}
  Branches   : ${branchCount}
  Dishes     : ${dishCount} total (${totalDishes} created this run)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`)
}

main()
  .catch(e => { console.error('FATAL:', e.message); process.exit(1) })
  .finally(() => prisma.$disconnect())
