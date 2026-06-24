/**
 * Safe migration: add billPrinterIp and billPrinterPort columns to the
 * restaurants table. Uses IF NOT EXISTS so it's safe to re-run.
 * Run: node scripts/add-bill-printer-columns.mjs
 */
import { createRequire } from 'module'
import { resolve } from 'path'
import { readFileSync } from 'fs'

for (const file of ['.env.local', '.env']) {
  try {
    for (const line of readFileSync(resolve(process.cwd(), file), 'utf8').split('\n')) {
      const t = line.trim(); if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('='); if (eq < 0) continue
      const k = t.slice(0, eq).trim(), v = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
      if (!process.env[k]) process.env[k] = v
    }
  } catch {}
}

const require = createRequire(import.meta.url)
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } })

await prisma.$executeRawUnsafe(`ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "billPrinterIp" TEXT`)
console.log('✓ billPrinterIp column ready')

await prisma.$executeRawUnsafe(`ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "billPrinterPort" INTEGER`)
console.log('✓ billPrinterPort column ready')

await prisma.$disconnect()
console.log('\nDone.')
