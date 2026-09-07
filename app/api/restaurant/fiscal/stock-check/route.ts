import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { getRestaurantSharedStock } from '@/lib/inventoryConsumption'
import { availabilityByDish, type RecipeLine } from '@/lib/fiscalStockAvailability'
import { checkFiscalStock, describeStockRefusal, type StockGuardLine } from '@/lib/fiscalStockGuard'

export const dynamic = 'force-dynamic'

// Refusing a receipt when the goods are not there (§7.30).
//
//   "not issue a receipt of goods when the corresponding stock is less than the
//    requested quantity. However, CIS can issue a receipt for service item
//    regardless the stock."
//
// POST { orderId }            check a bill already on the floor
// POST { lines: [{ dishId, qty }] }  check before one exists
//
// ── Why this is its own endpoint ────────────────────────────────────────────
//
// The same check has to run in two places: the till asks BEFORE it takes money,
// so a waiter finds out while the guest is still standing there, and settlement
// asks again inside its own transaction, because stock can go in the seconds
// between. This is the first of those. It decides nothing on its own — it
// reports, and the refusal at settlement is the one that binds.
//
// The answer names every short line rather than the first. A waiter told
// "something is out of stock" has to guess; a waiter told which two dishes are
// short fixes the order in one go.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null
  if (!restaurantId || !branchId) return NextResponse.json({ error: 'No outlet selected' }, { status: 400 })

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : ''

  // Either shape reduces to the same thing: how many of which dish.
  let wanted: Array<{ dishId: string; qty: number }> = []

  if (orderId) {
    const order = await prisma.restaurantOrder.findFirst({
      where: { id: orderId, restaurantId, deletedAt: null },
      select: { items: { where: { status: 'ACTIVE' }, select: { dishId: true, qty: true } } },
    })
    if (!order) return NextResponse.json({ error: 'Bill not found' }, { status: 404 })
    wanted = order.items
      .filter((item): item is { dishId: string; qty: number } => Boolean(item.dishId))
      .map((item) => ({ dishId: item.dishId, qty: Number(item.qty ?? 0) }))
  } else if (Array.isArray(body.lines)) {
    wanted = (body.lines as Array<Record<string, unknown>>)
      .map((line) => ({ dishId: String(line.dishId ?? '').trim(), qty: Number(line.qty ?? 0) }))
      .filter((line) => line.dishId && Number.isFinite(line.qty) && line.qty > 0)
  }

  if (wanted.length === 0) {
    return NextResponse.json({ allowed: true, refusals: [], message: null })
  }

  // Same quantity per dish is asked for once, however many times it appears.
  const totalByDish = new Map<string, number>()
  for (const line of wanted) {
    totalByDish.set(line.dishId, (totalByDish.get(line.dishId) ?? 0) + line.qty)
  }
  const dishIds = [...totalByDish.keys()]

  const dishes = await prisma.dish.findMany({
    where: { id: { in: dishIds }, restaurantId, deletedAt: null },
    select: {
      id: true, name: true, itemCode: true, itemType: true, preparedPortions: true,
      ingredients: { select: { inventoryItemId: true, quantityRequired: true } },
    },
  })

  const recipesByDishId = new Map<string, RecipeLine[]>(
    dishes.map((dish) => [dish.id, dish.ingredients.map((row) => ({
      inventoryItemId: row.inventoryItemId,
      quantityRequired: Number(row.quantityRequired ?? 0),
    }))]),
  )

  const neededItemIds = [...new Set(dishes.flatMap((dish) => dish.ingredients.map((row) => row.inventoryItemId)))]

  // The shared pool sits at the main station and belongs to every station, so
  // scoping to the signed-in branch would read a full store as empty.
  const sharedStock = await getRestaurantSharedStock(prisma, restaurantId)
  const stockRows = neededItemIds.length
    ? await prisma.inventoryItem.findMany({
        where: {
          id: { in: neededItemIds },
          restaurantId,
          deletedAt: null,
          ...(sharedStock ? {} : { branchId }),
        },
        select: { id: true, quantity: true },
      })
    : []

  const onHand = new Map(stockRows.map((row) => [row.id, Number(row.quantity ?? 0)]))
  const available = availabilityByDish(dishes, recipesByDishId, onHand)

  const guardLines: StockGuardLine[] = dishes.map((dish) => ({
    name: dish.name,
    itemCode: dish.itemCode,
    qty: totalByDish.get(dish.id) ?? 0,
    itemType: dish.itemType,
    available: available.get(dish.id),
  }))

  const refusals = checkFiscalStock(guardLines)

  return NextResponse.json({
    allowed: refusals.length === 0,
    refusals,
    message: describeStockRefusal(refusals),
  })
}
