import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'
import { buildUpsellingReport, type UpsellCheck } from '../lib/upsellingReport'

function readEnvVar(file: string, key: string) {
  const content = fs.readFileSync(file, 'utf8')
  const line = content.split('\n').find((l) => l.startsWith(`${key}=`))
  if (!line) return undefined
  return line.slice(key.length + 1).trim().replace(/^"|"$/g, '')
}

const url = readEnvVar('.env.local', 'DATABASE_URL')
const prisma = new PrismaClient({ datasources: { db: { url } } })

const orders = await prisma.restaurantOrder.findMany({
  where: { status: 'PAID', deletedAt: null },
  select: {
    id: true,
    staffId: true,
    createdByName: true,
    totalAmount: true,
    guestCount: true,
    staff: { select: { name: true } },
    items: {
      where: { status: 'ACTIVE', deletedAt: null },
      select: { dishId: true, dishName: true, qty: true, dishPrice: true },
    },
  },
})

const dishIds = Array.from(new Set(orders.flatMap((o) => o.items.map((i) => i.dishId))))
const dishes = await prisma.dish.findMany({
  where: { id: { in: dishIds } },
  select: { id: true, category: true },
})
const categoryByDishId = new Map(dishes.map((d) => [d.id, d.category]))

const checks: UpsellCheck[] = orders.map((order) => ({
  orderId: order.id,
  staffId: order.staffId ?? null,
  staffName: order.staff?.name ?? null,
  createdByName: order.createdByName ?? null,
  totalAmount: Number(order.totalAmount ?? 0),
  guestCount: order.guestCount ?? null,
  items: order.items.map((item) => ({
    dishId: item.dishId,
    dishName: item.dishName,
    category: categoryByDishId.get(item.dishId) ?? null,
    qty: Number(item.qty ?? 0),
    dishPrice: Number(item.dishPrice ?? 0),
  })),
}))

const report = buildUpsellingReport(checks)

console.log('=== META ===', report.meta)
console.log('\n=== HOUSE ===')
console.log({
  checks: report.house.checks,
  addonRate: report.house.addonRate,
  drinkAttachRate: report.house.drinkAttachRate,
  foodChecks: report.house.foodChecks,
  avgCheck: report.house.avgCheck,
  itemsPerCheck: report.house.itemsPerCheck,
  upsellRevenue: report.house.upsellRevenue,
  upsellRevenueShare: report.house.upsellRevenueShare,
  apc: report.house.apc,
})

console.log('\n=== PER SERVER ===')
for (const r of report.rows) {
  console.log(
    `${r.serverName.padEnd(18)} | term=${(r.terminalAccount ?? "—").padEnd(18)} bills=${String(r.checks).padStart(3)}  addon=${String(r.addonRate).padStart(5)}%  drink=${r.drinkAttachRate === null ? '   — ' : String(r.drinkAttachRate).padStart(5) + '%'}  avg=${String(r.avgCheck).padStart(7)}  items/bill=${r.itemsPerCheck}  upsellShare=${r.upsellRevenueShare}%`
  )
}

console.log('\n=== TOP ATTACHED ITEMS ===')
for (const i of report.attachedItems.slice(0, 12)) {
  console.log(`${i.dishName.padEnd(28)} ${String(i.group).padEnd(6)} qty=${String(i.qty).padStart(3)} | term=${(r.terminalAccount ?? "—").padEnd(18)} bills=${String(i.checks).padStart(3)} revenue=${i.revenue}`)
}

await prisma.$disconnect()
