/**
 * Turn one restaurant's shared stock on or off.
 *
 *   node scripts/set-shared-stock.mjs --restaurant "High 5ive" --on
 *   node scripts/set-shared-stock.mjs --restaurant "High 5ive" --off
 *
 * On its own this changes no data at all — it only changes where the app looks
 * for stock. Turning it on widens the search from one station to the whole
 * restaurant, which cannot fail to find what the narrower search already found,
 * so every dish keeps working while stock is still held per station. Turning it
 * off puts the behaviour back immediately.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../package.json', import.meta.url))
const { PrismaClient } = require('@prisma/client')

const args = process.argv.slice(2)
const name = args[args.indexOf('--restaurant') + 1]
const turnOn = args.includes('--on')
const turnOff = args.includes('--off')

if (!name || name.startsWith('--') || turnOn === turnOff) {
  console.error('Usage: node scripts/set-shared-stock.mjs --restaurant "<name>" --on|--off')
  process.exit(1)
}

const line = readFileSync(new URL('../.env.vercel.production', import.meta.url), 'utf8')
  .split('\n').find((l) => l.trim().startsWith('DATABASE_URL'))
const url = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')
const prisma = new PrismaClient({ datasources: { db: { url } }, log: ['warn'] })

const restaurant = await prisma.restaurant.findFirst({
  where: { name },
  select: { id: true, name: true, sharedStock: true },
})
if (!restaurant) {
  console.error(`No restaurant named "${name}".`)
  process.exit(1)
}

const branches = await prisma.branch.findMany({
  where: { restaurantId: restaurant.id },
  select: { id: true, name: true, isMain: true },
})
const main = branches.find((b) => b.isMain)
if (turnOn && !main) {
  console.error('No main station, so there is nowhere to hold the shared stock.')
  process.exit(1)
}

console.log(`${restaurant.name}: shared stock ${restaurant.sharedStock ? 'ON' : 'OFF'} -> ${turnOn ? 'ON' : 'OFF'}`)
if (restaurant.sharedStock === turnOn) {
  console.log('Already in that state. Nothing to do.')
  process.exit(0)
}

await prisma.restaurant.update({
  where: { id: restaurant.id },
  data: { sharedStock: turnOn },
})

const items = await prisma.inventoryItem.count({ where: { restaurantId: restaurant.id, deletedAt: null } })
console.log(`Done. ${items} stock rows are untouched and still where they were.`)
console.log(turnOn
  ? `Stock is now searched across the whole restaurant; ${main.name} will hold it once merged.`
  : 'Stock is searched per station again, exactly as before.')

await prisma.$disconnect()
