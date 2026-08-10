import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'

const dbPath = 'C:/Users/HP/AppData/Roaming/restaurant-app/data/dev.db'
const prisma = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } })

const dump = JSON.parse(fs.readFileSync('scripts/_high5ive_dump.json', 'utf8'))
const u = dump.user

const updated = await prisma.user.update({
  where: { id: u.id },
  data: {
    businessType: u.businessType,
    logoUrl: u.logoUrl,
    trackingMode: u.trackingMode,
    fifoEnabled: u.fifoEnabled,
  },
  select: { email: true, trackingMode: true, businessType: true, fifoEnabled: true, logoUrl: true },
})

console.log('Local user settings corrected to match cloud:', updated)

// Also verify the restaurant record's fifo fields match cloud exactly.
const r = dump.restaurant
const restoredRestaurant = await prisma.restaurant.update({
  where: { id: r.id },
  data: {
    billHeader: r.billHeader,
    billPrinterIp: r.billPrinterIp,
    billPrinterPort: r.billPrinterPort,
    qrOrderingMode: r.qrOrderingMode,
    fifoEnabled: r.fifoEnabled,
    fifoConfiguredAt: r.fifoConfiguredAt ? new Date(r.fifoConfiguredAt) : null,
  },
  select: { name: true, qrOrderingMode: true, fifoEnabled: true, billHeader: true },
})
console.log('Restaurant settings corrected to match cloud:', restoredRestaurant)

await prisma.$disconnect()
