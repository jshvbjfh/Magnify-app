import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { NO_CHARGE_METHOD_VALUES } from '@/lib/restaurantOrders'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { endOfRestaurantDay, startOfRestaurantDay } from '@/lib/restaurantDay'

// Money must never be served from a cache — same rule as every other report.
export const dynamic = 'force-dynamic'

function parseDateParam(value: string | null, endOfDay = false) {
  // Days are restaurant days, not server days — see lib/restaurantDay.
  return endOfDay ? endOfRestaurantDay(value) : startOfRestaurantDay(value)
}

// GET — every comped bill in the window: what was given away, to whose table,
// on whose authority, and why.
//
// A comp is deliberately invisible to every other report. The order closes with
// its totals at zero, so revenue, average-per-cover and sales-by-dish all count
// it as nothing — which is right, because nothing was collected. That is exactly
// why this report has to exist: the food was still cooked, the stock still left
// the store, and without a page that adds the comps up, free meals are the one
// cost in the building that nothing on screen ever names.
//
// The value comes from compedAmount, written when the bill was settled. It is
// the only surviving record of what the table was worth, since the order itself
// was written down to zero.
//
// ?from=YYYY-MM-DD&to=YYYY-MM-DD
export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  if (!restaurantId) {
    return NextResponse.json({ rows: [], totals: { orders: 0, value: 0, covers: 0 }, byAuthoriser: [], byReason: [] })
  }

  const { searchParams } = new URL(req.url)
  const fromDate = parseDateParam(searchParams.get('from'))
  const toDate = parseDateParam(searchParams.get('to'), true)

  const range = { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lte: toDate } : {}) }

  const [orders, branches] = await Promise.all([
    prisma.restaurantOrder.findMany({
      where: {
        restaurantId,
        status: 'PAID',
        // Every spelling the tender has ever been stored under. The name changed
        // to 'compl.' after 'No Charge' had already shipped to tills, and a comp
        // missing from this report is a free meal nothing in the building names.
        paymentMethod: { in: NO_CHARGE_METHOD_VALUES },
        deletedAt: null,
        ...(fromDate || toDate
          ? {
              OR: [
                { businessDate: range },
                { businessDate: null, paidAt: range },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        orderNumber: true,
        branchId: true,
        tableName: true,
        createdByName: true,
        settledByName: true,
        noChargeReason: true,
        compedAmount: true,
        guestCount: true,
        paidAt: true,
        businessDate: true,
        createdAt: true,
        items: {
          where: { status: 'ACTIVE' },
          select: { dishName: true, qty: true },
        },
      },
      orderBy: { paidAt: 'desc' },
    }),
    prisma.branch.findMany({
      where: { restaurantId, deletedAt: null },
      select: { id: true, name: true },
    }),
  ])

  const branchNameById = new Map(branches.map((branch) => [branch.id, branch.name]))

  const rows = orders.map((order) => ({
    id: order.id,
    orderNumber: order.orderNumber,
    stationName: branchNameById.get(order.branchId) ?? 'Unknown station',
    tableName: order.tableName ?? 'Takeaway',
    // The waiter keeps the table. Comping it does not move the sale to whoever
    // authorised the comp.
    createdByName: order.createdByName ?? '—',
    // Whoever closed the bill. On a comp this is the person who authorised it,
    // which is the accountability the report exists for. Null when the waiter
    // comped their own table, and on records written before it was stored.
    authorisedByName: order.settledByName,
    reason: order.noChargeReason?.trim() || 'No reason given',
    // Null on comps recorded before compedAmount existed; treated as 0 so one
    // legacy row can never make the total unreadable.
    value: Number(order.compedAmount ?? 0),
    // Null means the waiter skipped the cover count, never zero guests — so it
    // stays null here and is left out of the covers total entirely.
    guestCount: order.guestCount,
    paidAt: order.paidAt?.toISOString() ?? null,
    businessDate: (order.businessDate ?? order.paidAt ?? order.createdAt).toISOString(),
    itemCount: order.items.reduce((sum, item) => sum + Number(item.qty), 0),
    items: order.items.map((item) => ({ dishName: item.dishName, qty: item.qty })),
  }))

  const tally = (key: (row: (typeof rows)[number]) => string) => {
    const map = new Map<string, { name: string; orders: number; value: number }>()
    for (const row of rows) {
      const name = key(row)
      const entry = map.get(name) ?? { name, orders: 0, value: 0 }
      entry.orders += 1
      entry.value += row.value
      map.set(name, entry)
    }
    return [...map.values()].sort((a, b) => b.value - a.value)
  }

  return NextResponse.json({
    rows,
    totals: {
      orders: rows.length,
      value: rows.reduce((sum, row) => sum + row.value, 0),
      covers: rows.reduce((sum, row) => sum + (row.guestCount ?? 0), 0),
    },
    // Who is giving food away, and on what grounds. One name or one reason
    // running away with the total is the point of putting these here.
    byAuthoriser: tally((row) => row.authorisedByName ?? 'Not recorded'),
    byReason: tally((row) => row.reason),
  })
}
