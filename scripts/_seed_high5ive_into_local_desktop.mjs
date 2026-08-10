import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'

const dbPath = 'C:/Users/HP/AppData/Roaming/restaurant-app/data/dev.db'
const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } })

const dump = JSON.parse(fs.readFileSync('scripts/_high5ive_dump.json', 'utf8'))

function toDate(v) {
  return v ? new Date(v) : null
}

// ── User (admin login) ─────────────────────────────────────────────
const u = dump.user
await prisma.user.upsert({
  where: { id: u.id },
  update: {
    name: u.name,
    email: u.email,
    password: u.password,
    role: u.role,
    isActive: u.isActive,
    isSuperAdmin: u.isSuperAdmin,
  },
  create: {
    id: u.id,
    name: u.name,
    email: u.email,
    password: u.password,
    role: u.role,
    isActive: u.isActive,
    isSuperAdmin: u.isSuperAdmin,
    createdAt: toDate(u.createdAt),
  },
})
console.log('User seeded:', u.email)

// ── Restaurant ──────────────────────────────────────────────────────
const r = dump.restaurant
await prisma.restaurant.upsert({
  where: { id: r.id },
  update: {
    name: r.name,
    ownerId: r.ownerId,
    managerId: r.managerId,
    joinCode: r.joinCode,
    syncRestaurantId: r.syncRestaurantId,
    licenseActive: r.licenseActive,
    licenseExpiry: toDate(r.licenseExpiry),
    deletedAt: toDate(r.deletedAt),
  },
  create: {
    id: r.id,
    name: r.name,
    ownerId: r.ownerId,
    managerId: r.managerId,
    joinCode: r.joinCode,
    syncRestaurantId: r.syncRestaurantId,
    licenseActive: r.licenseActive,
    licenseExpiry: toDate(r.licenseExpiry),
    createdAt: toDate(r.createdAt),
  },
})
console.log('Restaurant seeded:', r.name)

// ── Branches ────────────────────────────────────────────────────────
for (const b of dump.branches) {
  await prisma.branch.upsert({
    where: { id: b.id },
    update: {
      restaurantId: b.restaurantId,
      name: b.name,
      code: b.code,
      type: b.type,
      isMain: b.isMain,
      isActive: b.isActive,
      deletedAt: toDate(b.deletedAt),
    },
    create: {
      id: b.id,
      restaurantId: b.restaurantId,
      name: b.name,
      code: b.code,
      type: b.type,
      isMain: b.isMain,
      isActive: b.isActive,
      createdAt: toDate(b.createdAt),
    },
  })
}
console.log('Branches seeded:', dump.branches.length)

// ── Staff ───────────────────────────────────────────────────────────
for (const s of dump.staff) {
  await prisma.staff.upsert({
    where: { id: s.id },
    update: {
      restaurantId: s.restaurantId,
      name: s.name,
      role: s.role,
      username: s.username,
      password: s.password,
      pin: s.pin,
      cancellationPin: s.cancellationPin,
      hourlyRate: s.hourlyRate,
      isActive: s.isActive,
      deletedAt: toDate(s.deletedAt),
    },
    create: {
      id: s.id,
      restaurantId: s.restaurantId,
      name: s.name,
      role: s.role,
      username: s.username,
      password: s.password,
      pin: s.pin,
      cancellationPin: s.cancellationPin,
      hourlyRate: s.hourlyRate,
      isActive: s.isActive,
      createdAt: toDate(s.createdAt),
    },
  })
}
console.log('Staff seeded:', dump.staff.length)

// ── StaffBranch links ──────────────────────────────────────────────
for (const sb of dump.staffBranches) {
  await prisma.staffBranch.upsert({
    where: { id: sb.id },
    update: { staffId: sb.staffId, branchId: sb.branchId },
    create: { id: sb.id, staffId: sb.staffId, branchId: sb.branchId, createdAt: toDate(sb.createdAt) },
  })
}
console.log('StaffBranch links seeded:', dump.staffBranches.length)

await prisma.$disconnect()
console.log('\nDone. Local desktop DB now has login + restaurant/branch/staff records for high5ive@management.com.')
