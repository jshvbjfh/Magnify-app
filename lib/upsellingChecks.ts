import { prisma } from '@/lib/prisma'
import { endOfRestaurantDay, startOfRestaurantDay } from '@/lib/restaurantDay'
import type { UpsellCheck } from '@/lib/upsellingReport'

// Loading the bills an upsell report reasons about.
//
// Extracted so the report and its pairing explorer read the SAME bills. When
// each route built its own query they drifted apart in exactly the ways that
// matter — one joining menuType and the other not, one excluding a status the
// other kept — and a drill-down that disagrees with the figure it drills into
// is worse than no drill-down at all.

export type UpsellCheckRange = {
  restaurantId: string
  /** YYYY-MM-DD at the restaurant, inclusive. Null for all time. */
  from?: string | null
  to?: string | null
}

/**
 * Paid, undeleted bills for the restaurant, with each line's category, menuType
 * and real FIFO food cost attached.
 *
 * Restaurant-account-wide on purpose, never per station: one check routinely
 * spans stations (a Grill burger and a Bar soda are one guest, one bill, one
 * waiter's upsell), so slicing by branch would report the opposite of what
 * happened. See lib/upsellingReport.ts.
 */
export async function loadUpsellChecks({ restaurantId, from, to }: UpsellCheckRange): Promise<UpsellCheck[]> {
  const fromDate = startOfRestaurantDay(from)
  const toDate = endOfRestaurantDay(to)

  // Group by the shift's business day when the order has one, else fall back to
  // paidAt — a table opened at 11pm and paid at 1am counts on the shift's day.
  const paidRange = { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lte: toDate } : {}) }
  const orders = await prisma.restaurantOrder.findMany({
    where: {
      restaurantId,
      status: 'PAID',
      deletedAt: null,
      ...(fromDate || toDate
        ? { OR: [{ businessDate: paidRange }, { businessDate: null, paidAt: paidRange }] }
        : {}),
    },
    select: {
      id: true,
      staffId: true,
      createdByName: true,
      totalAmount: true,
      guestCount: true,
      // When the order was RUNG UP, which is when the upsell was made or missed.
      // The day range above still keys on businessDate/paidAt — those are what
      // the indexes cover — so this only ever places the bill in an hour.
      createdAt: true,
      staff: { select: { name: true } },
      items: {
        where: { status: 'ACTIVE', deletedAt: null },
        select: { id: true, dishId: true, dishName: true, qty: true, dishPrice: true, discountPercent: true },
      },
    },
  })

  if (orders.length === 0) return []

  const orderIds = orders.map((order) => order.id)
  const dishIds = Array.from(new Set(orders.flatMap((order) => order.items.map((item) => item.dishId))))

  const [dishes, sales] = await Promise.all([
    // Category lives on the Dish, not on the denormalised order line, so the
    // menu has to be joined in to classify what was sold. menuType comes along
    // as the tie-breaker for categories the word list does not recognise —
    // without it every wine, coffee and juice at Sirocco is counted as food.
    dishIds.length > 0
      ? prisma.dish.findMany({
          where: { id: { in: dishIds }, restaurantId },
          select: { id: true, category: true, menuType: true },
        })
      : Promise.resolve([]),
    // Real food cost per line, FIFO-costed when the sale was recorded. This is
    // what lets the report rank by gross profit rather than revenue — a cheap
    // side can out-earn a premium main once cost is taken off.
    prisma.dishSale.findMany({
      where: { orderId: { in: orderIds }, restaurantId, deletedAt: null },
      select: { orderItemId: true, calculatedFoodCost: true },
    }),
  ])

  const menuByDishId = new Map(dishes.map((dish) => [dish.id, dish]))

  const costByOrderItemId = new Map<string, number>()
  for (const sale of sales) {
    if (!sale.orderItemId) continue
    costByOrderItemId.set(
      sale.orderItemId,
      (costByOrderItemId.get(sale.orderItemId) ?? 0) + Number(sale.calculatedFoodCost ?? 0)
    )
  }

  return orders.map((order) => ({
    orderId: order.id,
    staffId: order.staffId ?? null,
    staffName: order.staff?.name ?? null,
    createdByName: order.createdByName ?? null,
    totalAmount: Number(order.totalAmount ?? 0),
    guestCount: order.guestCount ?? null,
    orderedAt: order.createdAt,
    items: order.items.map((item) => ({
      dishId: item.dishId,
      dishName: item.dishName,
      category: menuByDishId.get(item.dishId)?.category ?? null,
      menuType: menuByDishId.get(item.dishId)?.menuType ?? null,
      qty: Number(item.qty ?? 0),
      dishPrice: Number(item.dishPrice ?? 0),
      discountPercent: item.discountPercent,
      // Null, not 0, when a line was never costed — the report counts those
      // separately instead of silently reporting them as pure profit.
      foodCost: costByOrderItemId.has(item.id) ? (costByOrderItemId.get(item.id) as number) : null,
    })),
  }))
}
