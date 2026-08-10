import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'

function readEnvVar(file, key) {
  const content = fs.readFileSync(file, 'utf8')
  const line = content.split('\n').find(l => l.startsWith(`${key}=`))
  if (!line) return null
  return line.slice(key.length + 1).trim().replace(/^"|"$/g, '')
}

const url = readEnvVar('.env.local', 'DATABASE_URL')
const prisma = new PrismaClient({ datasources: { db: { url } } })

const orders = await prisma.restaurantOrder.findMany({
  where: { status: 'PAID', deletedAt: null },
  select: {
    id: true,
    createdByName: true,
    staffId: true,
    shiftId: true,
    staff: { select: { name: true, role: true } },
    shift: { select: { openedByName: true, openedByStaffId: true, sourceDeviceId: true } },
  },
})

console.log('paid orders:', orders.length)
console.log('with shiftId:', orders.filter(o => o.shiftId).length)
console.log('shift has openedByName:', orders.filter(o => o.shift?.openedByName).length)

const combos = new Map()
for (const o of orders) {
  const key = `createdByName=${o.createdByName ?? 'null'} | staff.name=${o.staff?.name ?? 'null'} | shift.openedByName=${o.shift?.openedByName ?? 'null'}`
  combos.set(key, (combos.get(key) ?? 0) + 1)
}
console.log('\n=== IDENTITY COMBINATIONS (paid orders) ===')
for (const [k, n] of [...combos.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`${String(n).padStart(4)}  ${k}`)
}

console.log('\n=== STAFF ROSTER ===')
const staff = await prisma.staff.findMany({
  where: { deletedAt: null },
  select: { id: true, name: true, role: true, isActive: true },
  orderBy: { name: 'asc' },
})
for (const s of staff) console.log(`  ${s.name} — role=${s.role} active=${s.isActive}`)

console.log('\n=== SHIFTS ===')
const shifts = await prisma.shift.findMany({
  where: { deletedAt: null },
  select: { id: true, openedByName: true, openedByStaffId: true, businessDate: true, status: true, sourceDeviceId: true },
  orderBy: { openedAt: 'desc' },
  take: 15,
})
for (const s of shifts) {
  console.log(`  ${s.businessDate?.toISOString().slice(0, 10)} openedBy=${s.openedByName ?? 'null'} staffId=${s.openedByStaffId ?? 'null'} device=${s.sourceDeviceId ?? 'null'} ${s.status}`)
}

await prisma.$disconnect()
