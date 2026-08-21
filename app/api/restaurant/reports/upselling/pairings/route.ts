import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { loadUpsellChecks } from '@/lib/upsellingChecks'
import { buildPairingExplorer, type PairingSubject } from '@/lib/upsellingReport'

// Money must never be served from a cache. Without this, Next can cache the
// GET response and keep returning figures from before a correction landed.
export const dynamic = 'force-dynamic'

const EMPTY = {
  subject: null,
  bills: 0,
  subjectBills: 0,
  rows: [],
  meta: { totalChecks: 0, selfOrderChecks: 0, belowFloor: 0, uncostedLines: 0 },
}

function parseHour(value: string | null): number | null {
  if (value === null || value.trim() === '') return null
  const hour = Number(value)
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null
}

// GET — the pairing explorer: what sells alongside one dish or one category.
//
// ?dishId=… | ?category=…   the subject being asked about (one is required)
// &from=YYYY-MM-DD&to=YYYY-MM-DD
// &hourFrom=18&hourTo=22    optional service window
//
// Answers can come from any menu, category or sub-category — asking what goes
// with a steak must be able to reply "a red wine", which lives on a different
// menu entirely. That cross-menu answer is the point of the endpoint.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  if (!restaurantId) return NextResponse.json(EMPTY)

  const { searchParams } = new URL(req.url)
  const dishId = searchParams.get('dishId')?.trim() || null
  const category = searchParams.get('category')?.trim() || null

  // One subject, always. Without it there is no question to answer, and
  // defaulting to "everything" would quietly return a cross-join of the menu.
  const subject: PairingSubject | null = dishId
    ? { kind: 'dish', dishId }
    : category
      ? { kind: 'category', category }
      : null
  if (!subject) {
    return NextResponse.json({ error: 'Pass dishId or category' }, { status: 400 })
  }

  const checks = await loadUpsellChecks({
    restaurantId,
    from: searchParams.get('from'),
    to: searchParams.get('to'),
  })
  if (checks.length === 0) return NextResponse.json(EMPTY)

  return NextResponse.json(
    buildPairingExplorer(checks, subject, {
      hourFrom: parseHour(searchParams.get('hourFrom')),
      hourTo: parseHour(searchParams.get('hourTo')),
    })
  )
}
