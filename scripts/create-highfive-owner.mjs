/**
 * Creates an owner account for the "High Five" restaurant
 * and sets the current admin as manager so they retain access.
 * Run: node scripts/create-highfive-owner.mjs
 */
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Load .env.local so we connect to the cloud PostgreSQL DB
const envLocal = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8')
for (const line of envLocal.split('\n')) {
  const m = line.match(/^([^#=]+)=(.*)$/)
  if (m) process.env[m[1].trim()] = m[2].trim().replace(/^"|"$/g, '')
}

import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
const { hash } = bcrypt

const prisma = new PrismaClient()

async function main() {
  // Find the High Five restaurant (case-insensitive)
  const restaurant = await prisma.restaurant.findFirst({
    where: { name: { contains: 'high', mode: 'insensitive' }, deletedAt: null },
    select: { id: true, name: true, ownerId: true, managerId: true },
  })

  if (!restaurant) {
    console.error('❌  No restaurant with "high" in the name found. Restaurants available:')
    const all = await prisma.restaurant.findMany({ where: { deletedAt: null }, select: { id: true, name: true } })
    all.forEach((r) => console.log(`   • ${r.name} (${r.id})`))
    process.exit(1)
  }

  console.log(`✅  Found: ${restaurant.name} (${restaurant.id})`)
  console.log(`   Current ownerId : ${restaurant.ownerId}`)
  console.log(`   Current managerId: ${restaurant.managerId ?? 'none'}`)

  const ownerEmail = 'owner@highfive.com'
  const ownerPassword = 'HighFive2026!'
  const ownerName = 'High Five Owner'

  // Check if owner account already exists
  const existing = await prisma.user.findUnique({ where: { email: ownerEmail } })
  let ownerUser

  if (existing) {
    console.log(`ℹ️  User ${ownerEmail} already exists — updating password and role.`)
    ownerUser = await prisma.user.update({
      where: { id: existing.id },
      data: { role: 'owner', name: ownerName, password: await hash(ownerPassword, 12) },
    })
  } else {
    ownerUser = await prisma.user.create({
      data: {
        email: ownerEmail,
        name: ownerName,
        password: await hash(ownerPassword, 12),
        role: 'owner',
      },
    })
    console.log(`✅  Created owner user: ${ownerUser.id}`)
  }

  // Set ownerId to new owner, set managerId to former owner so admin keeps access
  await prisma.restaurant.update({
    where: { id: restaurant.id },
    data: {
      ownerId: ownerUser.id,
      managerId: restaurant.managerId ?? restaurant.ownerId, // preserve admin access
    },
  })

  console.log(`✅  Restaurant updated:`)
  console.log(`   ownerId   → ${ownerUser.id} (${ownerEmail})`)
  console.log(`   managerId → ${restaurant.managerId ?? restaurant.ownerId} (former owner keeps admin access)`)
  console.log()
  console.log('══════════════════════════════════════════')
  console.log('  OWNER APK LOGIN CREDENTIALS')
  console.log('══════════════════════════════════════════')
  console.log(`  Email    : ${ownerEmail}`)
  console.log(`  Password : ${ownerPassword}`)
  console.log('══════════════════════════════════════════')
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
