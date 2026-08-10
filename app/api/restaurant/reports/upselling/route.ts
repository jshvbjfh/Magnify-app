import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { endOfRestaurantDay, startOfRestaurantDay } from '@/lib/restaurantDay'
import { buildUpsellingReport, type UpsellCheck } from '@/lib/upsellingReport'

// Money must never be served from a cache. Without this, Next can cache the
// GET response and keep returning figures from before a correction landed —
// the page looks fine, refreshes cleanly, and still shows yesterday's numbers.
export const dynamic = 'force-dynamic'

function parseDateParam(value: string | null, endOfDay = false) {
  // Days are restaurant days, not server days — see lib/restaurantDay.
  return endOfDay ? endOfRestaurantDay(value) : startOfRestaurantDay(value)
}

const EMPTY = {
  rows: [],
  house: null,
  attachedItems: [],
  meta: { totalChecks: 0, checksWithoutServer: 0, coveredChecks: 0, uncategorizedItems: 0 },
}

// GET — upselling performance per server: how often they attach an add-on or a
// drink, how big their average bill is, and how that compares to the house.
//
// Restaurant-account-wide on purpose. Unlike branch-summary and
// dish-profitability, this report is NOT sliced per station: the check is the
// unit of analysis, and one check routinely spans stations (a Grill burger and
// a Bar soda are one guest, one bill, one server's upsell). See
// lib/upsellingReport.ts.
// ?from=YYYY-MM-DD&to=YYYY-MM-DD
export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  if (!restaurantId) return NextResponse.json(EMPTY)

  const { searchParams } = new URL(req.url)
  const fromDate = parseDateParam(searchParams.get('from'))
  const toDate = parseDateParam(searchParams.get('to'), true)

  // Group by the shift's business day when the order has one, else fall back to
  // paidAt — a table opened at 11pm and paid at 1am counts on the shift's day.
  const paidRange = { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lte: toDate } : {}) }
  const orders = await prisma.restaurantOrder.findMany({
    where: {
      restaurantId,
      status: 'PAID',
      deletedAt: null,
      ...(fromDate || toDate
        ? {
            OR: [
              { businessDate: paidRange },
              { businessDate: null, paidAt: paidRange },
            ],
          }
        : {}),
    },
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

  if (orders.length === 0) return NextResponse.json(EMPTY)

  // Category lives on the Dish, not on the denormalised order line, so the
  // menu has to be joined in to classify what was sold.
  const dishIds = Array.from(new Set(orders.flatMap((order) => order.items.map((item) => item.dishId))))
  const dishes = dishIds.length > 0
    ? await prisma.dish.findMany({
        where: { id: { in: dishIds }, restaurantId },
        select: { id: true, category: true },
      })
    : []
  const categoryByDishId = new Map(dishes.map((dish) => [dish.id, dish.category]))

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

  return NextResponse.json(buildUpsellingReport(checks))
}
