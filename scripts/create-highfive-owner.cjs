'use strict'
// Load cloud DB credentials before Prisma initialises
require('dotenv').config({ path: '.env.local' })
require('dotenv').config({ path: '.env' })

const { PrismaClient } = require('@prisma/client')
const bcrypt = require('bcryptjs')

const prisma = new PrismaClient()

async function main() {
  const restaurant = await prisma.restaurant.findFirst({
    where: { name: { contains: 'high', mode: 'insensitive' }, deletedAt: null },
    select: { id: true, name: true, ownerId: true, managerId: true },
  })

  if (!restaurant) {
    console.error('No restaurant with "high" in the name found. Available:')
    const all = await prisma.restaurant.findMany({ where: { deletedAt: null }, select: { name: true } })
    all.forEach((r) => console.log(' •', r.name))
    process.exit(1)
  }

  console.log(`Found: ${restaurant.name} (${restaurant.id})`)

  const ownerEmail = 'owner@highfive.com'
  const ownerPassword = 'HighFive2026!'
  const ownerName = 'High Five Owner'

  const existing = await prisma.user.findUnique({ where: { email: ownerEmail } })
  let ownerUser

  if (existing) {
    console.log(`User ${ownerEmail} already exists — updating.`)
    ownerUser = await prisma.user.update({
      where: { id: existing.id },
      data: { role: 'owner', name: ownerName, password: await bcrypt.hash(ownerPassword, 12) },
    })
  } else {
    ownerUser = await prisma.user.create({
      data: {
        email: ownerEmail,
        name: ownerName,
        password: await bcrypt.hash(ownerPassword, 12),
        role: 'owner',
      },
    })
    console.log(`Created owner user: ${ownerUser.id}`)
  }

  // Set new ownerId; preserve existing admin access via managerId
  await prisma.restaurant.update({
    where: { id: restaurant.id },
    data: {
      ownerId: ownerUser.id,
      managerId: restaurant.managerId ?? restaurant.ownerId,
    },
  })

  console.log(`\nRestaurant updated:`)
  console.log(`  ownerId   -> ${ownerUser.id}`)
  console.log(`  managerId -> ${restaurant.managerId ?? restaurant.ownerId} (admin keeps access)`)
  console.log(`\n═══════════════════════════════════════`)
  console.log(`  OWNER APK LOGIN CREDENTIALS`)
  console.log(`═══════════════════════════════════════`)
  console.log(`  Email    : ${ownerEmail}`)
  console.log(`  Password : ${ownerPassword}`)
  console.log(`═══════════════════════════════════════`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
