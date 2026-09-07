import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { endOfRestaurantDay, restaurantDayKey } from '@/lib/restaurantDay'
import { getIngredientLayerSnapshotAsOf } from '@/lib/inventoryLayerSnapshot'
import { getRestaurantSharedStock } from '@/lib/inventoryConsumption'

export const dynamic = 'force-dynamic'

// Closing stock at a date the user chooses (§7.31).
//
//   ?date=YYYY-MM-DD   defaults to today at the restaurant
//
// ── How the figure is arrived at ────────────────────────────────────────────
//
// Not "what is on hand now, adjusted backwards". Every purchase up to the
// chosen instant, less every consumption booked against those purchase layers
// up to the same instant — the FIFO ledger the rest of the app already keeps.
// That means a stock figure for last Tuesday stays correct however much has
// been bought or sold since, which is the whole point of asking for a date.
//
// ── The shared pool ─────────────────────────────────────────────────────────
//
// Where a restaurant keeps one shared pool, the stock physically sits at the
// main station and belongs to all of them. Scoping the snapshot to the station
// the manager happens to be signed into would then report almost nothing —
// a real store reading as empty. So under shared stock the branch filter is
// dropped and the whole restaurant is counted, which is what the pool IS.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null
  if (!restaurantId || !branchId) return NextResponse.json({ error: 'No outlet selected' }, { status: 400 })

  const { searchParams } = new URL(req.url)
  const dateKey = searchParams.get('date') ?? restaurantDayKey()
  // Inclusive of the whole chosen day: stock "as at the 8th" means after the
  // 8th's trading, not before it.
  const asOf = endOfRestaurantDay(dateKey) ?? endOfRestaurantDay(restaurantDayKey())!

  const sharedStock = await getRestaurantSharedStock(prisma, restaurantId)
  const scopeBranchId = sharedStock ? null : branchId

  const [{ ingredientTotals }, items] = await Promise.all([
    getIngredientLayerSnapshotAsOf(prisma, { restaurantId, branchId: scopeBranchId, endDate: asOf }),
    prisma.inventoryItem.findMany({
      where: {
        restaurantId,
        deletedAt: null,
        ...(scopeBranchId ? { branchId: scopeBranchId } : {}),
      },
      select: { id: true, name: true, unit: true, type: true },
      orderBy: { name: 'asc' },
    }),
  ])

  const rows = items.map((item) => {
    const totals = ingredientTotals.get(item.id)
    return {
      id: item.id,
      name: item.name,
      unit: item.unit,
      type: item.type,
      // No layer means nothing was ever bought, or everything bought is used
      // up. Zero either way — but reported, not omitted, so a store's full list
      // is visible and an auditor can see what was counted.
      quantity: totals?.quantity ?? 0,
      value: totals?.value ?? 0,
      openBatches: totals?.openPurchaseCount ?? 0,
    }
  })

  return NextResponse.json({
    date: dateKey,
    asOf: asOf.toISOString(),
    scope: sharedStock ? 'restaurant' : 'branch',
    rows,
    totals: {
      items: rows.length,
      inStock: rows.filter((row) => row.quantity > 0).length,
      value: Math.round(rows.reduce((sum, row) => sum + row.value, 0) * 100) / 100,
    },
  })
}
