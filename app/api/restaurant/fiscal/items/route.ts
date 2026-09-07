import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { ITEM_CODE_PREFIX, nextItemCodes, summarizeItemCodes } from '@/lib/fiscalItemCodes'

export const dynamic = 'force-dynamic'

// Item codes (VSDC API §4.17 — every item carries a unique code).
//
// ── Which code this is ──────────────────────────────────────────────────────
//
// Two different codes travel with a line, and only one of them is ours:
//
//   itemClsCd  RRA's classification for what the item IS, taken from their
//              published list. Not generated here — it is chosen.
//   itemCd     the taxpayer's own code for their own item. Ours to assign.
//
// This route deals only with the second.
//
// ── Why assignment is a POST and never automatic ────────────────────────────
//
// An item code is PERMANENT once issued: it appears on receipts already in
// guests' hands and in declarations already filed. A code that is quietly
// regenerated — on rename, on re-seed, on a branch move — breaks the link
// between a filed declaration and the item it declared.
//
// So codes are never assigned as a side effect of anything. Somebody asks, in
// one deliberate action, and existing codes are never overwritten: the POST
// fills gaps only.
//
// GET reports coverage and any duplicates it finds. It does NOT repair
// duplicates, for the same reason — reassigning a code that has already been
// declared is worse than reporting one that clashes.

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  if (!restaurantId) return NextResponse.json({ error: 'No outlet selected' }, { status: 400 })

  const dishes = await prisma.dish.findMany({
    where: { restaurantId, deletedAt: null },
    select: { id: true, name: true, branchId: true, itemCode: true, rraClassificationCode: true, itemType: true, taxCategory: true },
    orderBy: { createdAt: 'asc' },
  })

  return NextResponse.json(summarizeItemCodes(dishes))
}

// POST — assign a code to every item that has none.
//
// Idempotent: run it twice and the second run assigns nothing, because the
// first run left no gaps. Items that already carry a code are never touched.
export async function POST() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  if (!restaurantId) return NextResponse.json({ error: 'No outlet selected' }, { status: 400 })

  const assigned = await prisma.$transaction(async (tx) => {
    // Read inside the transaction: two managers pressing this at once must not
    // both compute the same next number and hand one code to two dishes.
    const dishes = await tx.dish.findMany({
      where: { restaurantId, deletedAt: null },
      select: { id: true, name: true, itemCode: true },
      orderBy: { createdAt: 'asc' },
    })

    const plan = nextItemCodes(dishes)
    for (const entry of plan) {
      await tx.dish.update({ where: { id: entry.id }, data: { itemCode: entry.itemCode } })
    }
    return plan
  })

  return NextResponse.json({
    assigned: assigned.length,
    prefix: ITEM_CODE_PREFIX,
    items: assigned,
  })
}
