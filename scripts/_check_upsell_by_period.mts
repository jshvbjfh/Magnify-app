import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'
import { buildUpsellingReport, type UpsellCheck } from '../lib/upsellingReport'

function readEnvVar(file: string, key: string) {
  const content = fs.readFileSync(file, 'utf8')
  const line = content.split('\n').find((l) => l.startsWith(`${key}=`))
  return line ? line.slice(key.length + 1).trim().replace(/^"|"$/g, '') : undefined
}

const prisma = new PrismaClient({ datasources: { db: { url: readEnvVar('.env.local', 'DATABASE_URL') } } })
const n = (v: number) => Math.round(v).toLocaleString('en-RW')

const realUsers = await prisma.user.findMany({
  where: { email: { endsWith: '@management.com' } }, select: { id: true },
})
const ids = realUsers.map((u) => u.id)
const realRestaurants = await prisma.restaurant.findMany({
  where: { OR: [{ ownerId: { in: ids } }, { managerId: { in: ids } }] },
  select: { id: true },
})
const restaurantIds = realRestaurants.map((r) => r.id)

// "Today" is 2026-08-10 for this check.
const NOW = new Date('2026-08-10T23:59:59.999Z')
const periods: { label: string; from: Date }[] = [
  { label: 'Today',        from: new Date('2026-08-10T00:00:00.000Z') },
  { label: 'Last 7 days',  from: new Date('2026-08-04T00:00:00.000Z') },
  { label: 'This month',   from: new Date('2026-08-01T00:00:00.000Z') },
  { label: 'Last 30 days', from: new Date('2026-07-12T00:00:00.000Z') },
  { label: 'This quarter', from: new Date('2026-07-01T00:00:00.000Z') },
  { label: 'This year',    from: new Date('2026-01-01T00:00:00.000Z') },
  { label: 'All time',     from: new Date('2000-01-01T00:00:00.000Z') },
]

console.log('PERIOD'.padEnd(15) + 'BILLS'.padStart(7) + 'PAIRINGS'.padStart(10) + 'OPPS'.padStart(6) + 'PROFIT'.padStart(12) + '   LEADER')

for (const p of periods) {
  const range = { gte: p.from, lte: NOW }
  const orders = await prisma.restaurantOrder.findMany({
    where: {
      restaurantId: { in: restaurantIds }, status: 'PAID', deletedAt: null,
      OR: [{ businessDate: range }, { businessDate: null, paidAt: range }],
    },
    select: {
      id: true, staffId: true, createdByName: true, totalAmount: true, guestCount: true,
      staff: { select: { name: true } },
      items: { where: { status: 'ACTIVE', deletedAt: null }, select: { id: true, dishId: true, dishName: true, qty: true, dishPrice: true } },
    },
  })
  const dishIds = Array.from(new Set(orders.flatMap((o) => o.items.map((i) => i.dishId))))
  const [dishes, sales] = await Promise.all([
    prisma.dish.findMany({ where: { id: { in: dishIds } }, select: { id: true, category: true } }),
    prisma.dishSale.findMany({
      where: { orderId: { in: orders.map((o) => o.id) }, deletedAt: null },
      select: { orderItemId: true, calculatedFoodCost: true },
    }),
  ])
  const catById = new Map(dishes.map((d) => [d.id, d.category]))
  const costBy = new Map<string, number>()
  for (const s of sales) if (s.orderItemId) costBy.set(s.orderItemId, (costBy.get(s.orderItemId) ?? 0) + Number(s.calculatedFoodCost ?? 0))

  const checks: UpsellCheck[] = orders.map((o) => ({
    orderId: o.id, staffId: o.staffId ?? null, staffName: o.staff?.name ?? null,
    createdByName: o.createdByName ?? null, totalAmount: Number(o.totalAmount ?? 0),
    guestCount: o.guestCount ?? null,
    items: o.items.map((i) => ({
      dishId: i.dishId, dishName: i.dishName, category: catById.get(i.dishId) ?? null,
      qty: Number(i.qty ?? 0), dishPrice: Number(i.dishPrice ?? 0),
      foodCost: costBy.has(i.id) ? (costBy.get(i.id) as number) : null,
    })),
  }))

  const r = buildUpsellingReport(checks)
  console.log(
    p.label.padEnd(15) +
    String(r.summary.bills).padStart(7) +
    String(r.pairings.length).padStart(10) +
    String(r.opportunities.length).padStart(6) +
    n(r.summary.upsellProfit).padStart(12) +
    '   ' + (r.summary.topServerName ?? '— none ranked')
  )
}

await prisma.$disconnect()
