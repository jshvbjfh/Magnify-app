import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { calculateLineNetAmount } from '@/lib/restaurantOrders'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { endOfRestaurantDay, startOfRestaurantDay } from '@/lib/restaurantDay'

// Money must never be served from a cache — same rule as every other report.
export const dynamic = 'force-dynamic'

function parseDateParam(value: string | null, endOfDay = false) {
  // Days are restaurant days, not server days — see lib/restaurantDay.
  return endOfDay ? endOfRestaurantDay(value) : startOfRestaurantDay(value)
}

// GET — every voided bill in the window: what was on it, what it would have been
// worth, who took it, who approved killing it, and why.
//
// This exists because a cancellation is the one action on the floor that makes
// money disappear without a trace on any sales report: a voided order simply
// stops being counted, so a table that was rung up, cooked, served and then
// voided looks identical to a table that never happened. Managers asked for the
// voids in one place precisely so that difference is visible.
//
// Restaurant-wide, spanning every station, and grouped by the shift's business
// day where the order carries one — a table opened at 11pm and voided at 1am
// belongs to the night that opened it.
//
// ?from=YYYY-MM-DD&to=YYYY-MM-DD
export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  if (!restaurantId) {
    return NextResponse.json({ rows: [], totals: { orders: 0, value: 0 }, byApprover: [], byReason: [] })
  }

  const { searchParams } = new URL(req.url)
  const fromDate = parseDateParam(searchParams.get('from'))
  const toDate = parseDateParam(searchParams.get('to'), true)

  const range = { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lte: toDate } : {}) }

  const [orders, branches] = await Promise.all([
    prisma.restaurantOrder.findMany({
      where: {
        restaurantId,
        status: 'CANCELED',
        deletedAt: null,
        ...(fromDate || toDate
          ? {
              OR: [
                { businessDate: range },
                { businessDate: null, canceledAt: range },
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
        canceledByName: true,
        cancelReason: true,
        canceledAt: true,
        businessDate: true,
        createdAt: true,
        // The lines carry the money. The order's own totalAmount is not trusted
        // here for the same reason the push handler does not trust it: the lines
        // are what the guest would actually have been charged, discounts and
        // all, and they are the only figure that can be reconciled against
        // anything.
        items: {
          select: { dishName: true, qty: true, dishPrice: true, discountPercent: true },
        },
      },
      orderBy: { canceledAt: 'desc' },
    }),
    prisma.branch.findMany({
      where: { restaurantId, deletedAt: null },
      select: { id: true, name: true },
    }),
  ])

  const branchNameById = new Map(branches.map((branch) => [branch.id, branch.name]))

  const rows = orders.map((order) => {
    // Every line on a cancelled order, not just the ACTIVE ones: cancelling the
    // order cancels its items too, so filtering to ACTIVE would value every
    // void at zero and the whole report would read as if nothing was ever lost.
    const value = order.items.reduce(
      (sum, item) =>
        sum
        + calculateLineNetAmount({
          dishPrice: Number(item.dishPrice),
          qty: Number(item.qty),
          discountPercent: item.discountPercent,
        }),
      0,
    )
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      stationName: branchNameById.get(order.branchId) ?? 'Unknown station',
      tableName: order.tableName ?? 'Takeaway',
      createdByName: order.createdByName ?? '—',
      // Null on every void recorded before the approver was stored. Shown as
      // "not recorded" rather than blamed on anyone.
      approvedByName: order.canceledByName,
      reason: order.cancelReason?.trim() || 'No reason given',
      canceledAt: order.canceledAt?.toISOString() ?? null,
      businessDate: (order.businessDate ?? order.canceledAt ?? order.createdAt).toISOString(),
      itemCount: order.items.reduce((sum, item) => sum + Number(item.qty), 0),
      items: order.items.map((item) => ({ dishName: item.dishName, qty: item.qty })),
      value,
    }
  })

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
    },
    // Who is signing off the voids, and what for. A single name or a single
    // reason dominating the list is the thing worth noticing here.
    byApprover: tally((row) => row.approvedByName ?? 'Not recorded'),
    byReason: tally((row) => row.reason),
  })
}
