import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { loadUpsellChecks } from '@/lib/upsellingChecks'
import { buildUpsellingReport } from '@/lib/upsellingReport'

// Money must never be served from a cache. Without this, Next can cache the
// GET response and keep returning figures from before a correction landed —
// the page looks fine, refreshes cleanly, and still shows yesterday's numbers.
export const dynamic = 'force-dynamic'

// An hour block, 0–23, at the restaurant. Anything else is treated as "not
// given" so a malformed link falls back to the whole day rather than 400-ing a
// manager out of their report.
function parseHourParam(value: string | null): number | null {
  if (value === null || value.trim() === '') return null
  const hour = Number(value)
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null
}

const EMPTY = {
  summary: {
    bills: 0, upsellRevenue: 0, upsellCost: 0, upsellProfit: 0, upsellMargin: 0,
    profitPerBill: 0, opportunity: 0, topServerName: null, topServerRate: null,
  },
  rows: [],
  house: null,
  pairings: [],
  opportunities: [],
  attachedItems: [],
  hourly: [],
  meta: {
    totalChecks: 0, serverChecks: 0, selfOrderChecks: 0, checksWithoutServer: 0,
    coveredChecks: 0, uncategorizedItems: 0, uncostedAttachLines: 0, pairingsTotal: 0,
    hourFrom: null, hourTo: null, checksOutsideWindow: 0,
  },
}

// GET — upselling performance per server: how often they attach an add-on or a
// drink, how big their average bill is, and how that compares to the house.
//
// Restaurant-account-wide on purpose. Unlike branch-summary and
// dish-profitability, this report is NOT sliced per station: the check is the
// unit of analysis, and one check routinely spans stations (a Grill burger and
// a Bar soda are one guest, one bill, one server's upsell). See
// lib/upsellingReport.ts.
//
// hourFrom/hourTo narrow it to one service window — 18–22 for dinner — so every
// waiter is judged on the same hours instead of a number that blends the coffee
// crowd with the cocktail crowd. Both ends are inclusive hour blocks at the
// restaurant, and hourFrom may be the larger of the two for late service
// (22→02). The `hourly` profile in the response always covers the whole date
// range regardless of the window; see lib/upsellingReport.ts.
// ?from=YYYY-MM-DD&to=YYYY-MM-DD&hourFrom=18&hourTo=22
export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  if (!restaurantId) return NextResponse.json(EMPTY)

  const { searchParams } = new URL(req.url)
  const hourFrom = parseHourParam(searchParams.get('hourFrom'))
  const hourTo = parseHourParam(searchParams.get('hourTo'))

  const checks = await loadUpsellChecks({
    restaurantId,
    from: searchParams.get('from'),
    to: searchParams.get('to'),
  })
  if (checks.length === 0) return NextResponse.json(EMPTY)

  return NextResponse.json(buildUpsellingReport(checks, { hourFrom, hourTo }))
}
