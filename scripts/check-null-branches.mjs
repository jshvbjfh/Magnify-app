import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PrismaClient } from '@prisma/client'

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue
    const key = trimmed.slice(0, eqIndex).trim()
    const value = trimmed.slice(eqIndex + 1).trim().replace(/^['"]|['"]$/g, '')
    if (!process.env[key]) process.env[key] = value
  }
}

loadEnvFile(resolve(process.cwd(), '.env.local'))
loadEnvFile(resolve(process.cwd(), '.env'))

const prisma = new PrismaClient()
const nullDishes = await prisma.dish.count({ where: { branchId: null } })
const nullTables = await prisma.restaurantTable.count({ where: { branchId: null } })
const totalDishes = await prisma.dish.count()
const totalTables = await prisma.restaurantTable.count()
console.log(`Dishes with null branchId: ${nullDishes} / ${totalDishes}`)
console.log(`Tables with null branchId: ${nullTables} / ${totalTables}`)
await prisma.$disconnect()
