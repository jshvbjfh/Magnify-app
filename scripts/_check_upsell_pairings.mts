import { PrismaClient } from '@prisma/client'
import fs from 'node:fs'
import { classifyCategory, isSelfOrder } from '../lib/upsellingReport'

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
    createdByName: true,
    staff: { select: { name: true } },
    items: {
      where: { status: 'ACTIVE', deletedAt: null },
      select: { id: true, dishId: true, dishName: true, qty: true, dishPrice: true },
    },
  },
})

const dishIds = Array.from(new Set(orders.flatMap((o) => o.items.map((i) => i.dishId))))
const dishes = await prisma.dish.findMany({
  where: { id: { in: dishIds } },
  select: { id: true, category: true },
})
const catById = new Map(dishes.map((d) => [d.id, d.category]))

// Actual food cost per line, already FIFO-costed when the sale was recorded.
const sales = await prisma.dishSale.findMany({
  where: { orderId: { in: orders.map((o) => o.id) }, deletedAt: null },
  select: { orderItemId: true, calculatedFoodCost: true },
})
const costByOrderItemId = new Map<string, number>()
for (const s of sales) {
  if (!s.orderItemId) continue
  costByOrderItemId.set(s.orderItemId, (costByOrderItemId.get(s.orderItemId) ?? 0) + Number(s.calculatedFoodCost ?? 0))
}

type Pair = { base: string; attach: string; together: number; qty: number; revenue: number; cost: number; costed: number }
const pairs = new Map<string, Pair>()
const baseCount = new Map<string, number>()
// Per-waiter attachment on each pair, for an empirical benchmark.
const waiterBase = new Map<string, number>()
const waiterBoth = new Map<string, number>()

let costedLines = 0
let uncostedLines = 0

for (const order of orders) {
  if (isSelfOrder(order)) continue
  const waiter = (order.createdByName || order.staff?.name || 'Unattributed').trim().toLowerCase()

  const foods = new Map<string, string>()
  const attaches = new Map<string, { name: string; qty: number; revenue: number; cost: number; costed: boolean }>()
  for (const item of order.items) {
    const group = classifyCategory(catById.get(item.dishId) ?? null)
    if (group === 'food') foods.set(item.dishId, item.dishName)
    if (group === 'addon' || group === 'drink') {
      const qty = Number(item.qty ?? 0)
      const revenue = qty * Number(item.dishPrice ?? 0)
      const cost = costByOrderItemId.get(item.id)
      if (cost === undefined) uncostedLines++
      else costedLines++
      const prev = attaches.get(item.dishId)
      attaches.set(item.dishId, {
        name: item.dishName,
        qty: (prev?.qty ?? 0) + qty,
        revenue: (prev?.revenue ?? 0) + revenue,
        cost: (prev?.cost ?? 0) + (cost ?? 0),
        costed: (prev?.costed ?? false) || cost !== undefined,
      })
    }
  }

  for (const [, baseName] of foods) {
    baseCount.set(baseName, (baseCount.get(baseName) ?? 0) + 1)
    // Once per order, not once per attached line — otherwise a bill with four
    // add-ons counts as four chances to sell the base item.
    waiterBase.set(`${waiter}|${baseName}`, (waiterBase.get(`${waiter}|${baseName}`) ?? 0) + 1)
    for (const [, a] of attaches) {
      const key = `${baseName} :: ${a.name}`
      const p = pairs.get(key) ?? { base: baseName, attach: a.name, together: 0, qty: 0, revenue: 0, cost: 0, costed: 0 }
      p.together += 1
      p.qty += a.qty
      p.revenue += a.revenue
      p.cost += a.cost
      if (a.costed) p.costed += 1
      pairs.set(key, p)
      waiterBoth.set(`${waiter}|${key}`, (waiterBoth.get(`${waiter}|${key}`) ?? 0) + 1)
    }
  }
}

const rows = Array.from(pairs.values())
  .filter((p) => (baseCount.get(p.base) ?? 0) >= 8 && p.together >= 4)
  .map((p) => {
    const base = baseCount.get(p.base) ?? 0
    const rate = base > 0 ? (p.together / base) * 100 : 0
    const profit = p.revenue - p.cost
    return { ...p, baseOrders: base, rate, profit, margin: p.revenue > 0 ? (profit / p.revenue) * 100 : 0 }
  })
  .sort((a, b) => b.profit - a.profit)

console.log('costed attach lines:', costedLines, '| uncosted:', uncostedLines)
console.log('\n=== TOP PAIRINGS (base seen >=8, together >=4) ===')
console.log('BASE'.padEnd(26), 'ATTACHED'.padEnd(24), 'BASE#'.padStart(6), 'TOG'.padStart(5), 'RATE'.padStart(7), 'REVENUE'.padStart(10), 'PROFIT'.padStart(10), 'MARGIN'.padStart(7))
for (const r of rows.slice(0, 18)) {
  console.log(
    r.base.slice(0, 25).padEnd(26),
    r.attach.slice(0, 23).padEnd(24),
    String(r.baseOrders).padStart(6),
    String(r.together).padStart(5),
    (r.rate.toFixed(1) + '%').padStart(7),
    Math.round(r.revenue).toLocaleString('en-RW').padStart(10),
    Math.round(r.profit).toLocaleString('en-RW').padStart(10),
    (r.margin.toFixed(0) + '%').padStart(7),
  )
}

console.log('\n=== BENCHMARK: best waiter rate per top pairing (base >=5 for that waiter) ===')
for (const r of rows.slice(0, 8)) {
  const key = `${r.base} :: ${r.attach}`
  let best = { waiter: '—', rate: 0, base: 0 }
  for (const [wk, wb] of waiterBase) {
    const [waiter, baseName] = wk.split('|')
    if (baseName !== r.base || wb < 5) continue
    const both = waiterBoth.get(`${waiter}|${key}`) ?? 0
    const rate = (both / wb) * 100
    if (rate > best.rate) best = { waiter, rate, base: wb }
  }
  const gap = Math.max(0, best.rate - r.rate)
  const avgValue = r.together > 0 ? r.revenue / r.together : 0
  const missed = (gap / 100) * r.baseOrders * avgValue
  console.log(
    `${r.base.slice(0, 22).padEnd(23)} + ${r.attach.slice(0, 20).padEnd(21)} house=${r.rate.toFixed(1).padStart(5)}%  best=${best.waiter.slice(0, 10).padEnd(11)}${best.rate.toFixed(1).padStart(5)}% (n=${best.base})  missed=${Math.round(missed).toLocaleString('en-RW')}`
  )
}

// Per-waiter upsell revenue and FIFO-costed profit.
const byWaiter = new Map<string, { bills: number; revenue: number; upsellRevenue: number; upsellCost: number }>()
for (const order of orders) {
  if (isSelfOrder(order)) continue
  const waiter = (order.createdByName || order.staff?.name || 'Unattributed').trim().toLowerCase()
  const w = byWaiter.get(waiter) ?? { bills: 0, revenue: 0, upsellRevenue: 0, upsellCost: 0 }
  w.bills += 1
  for (const item of order.items) {
    const group = classifyCategory(catById.get(item.dishId) ?? null)
    const qty = Number(item.qty ?? 0)
    const lineRevenue = qty * Number(item.dishPrice ?? 0)
    w.revenue += lineRevenue
    if (group === 'addon' || group === 'drink') {
      w.upsellRevenue += lineRevenue
      w.upsellCost += costByOrderItemId.get(item.id) ?? 0
    }
  }
  byWaiter.set(waiter, w)
}

console.log('\n=== PER-WAITER UPSELL PROFIT ===')
console.log('WAITER'.padEnd(16), 'BILLS'.padStart(6), 'UPSELL REV'.padStart(12), 'COST'.padStart(10), 'PROFIT'.padStart(11), 'MARGIN'.padStart(7), 'PROFIT/BILL'.padStart(12))
for (const [name, w] of [...byWaiter.entries()].sort((a, b) => (b[1].upsellRevenue - b[1].upsellCost) - (a[1].upsellRevenue - a[1].upsellCost)).slice(0, 8)) {
  const profit = w.upsellRevenue - w.upsellCost
  console.log(
    name.slice(0, 15).padEnd(16),
    String(w.bills).padStart(6),
    Math.round(w.upsellRevenue).toLocaleString('en-RW').padStart(12),
    Math.round(w.upsellCost).toLocaleString('en-RW').padStart(10),
    Math.round(profit).toLocaleString('en-RW').padStart(11),
    ((w.upsellRevenue > 0 ? (profit / w.upsellRevenue) * 100 : 0).toFixed(0) + '%').padStart(7),
    Math.round(w.bills > 0 ? profit / w.bills : 0).toLocaleString('en-RW').padStart(12),
  )
}

await prisma.$disconnect()
