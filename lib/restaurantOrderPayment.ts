import type { Prisma, PrismaClient } from '@prisma/client'

import { recordJournalEntry } from '@/lib/accounting'
import { recordDishSalesForPaidOrder } from '@/lib/dishSaleRecording'
import { isHotelBuffetLine } from '@/lib/hotelBuffet'
import { ACTIVE_RESTAURANT_ORDER_STATUSES, calculateRestaurantOrderTotals, enqueueOrderSync, syncRestaurantOrderTotals } from '@/lib/restaurantOrders'
import { enqueueRestaurantTableSync } from '@/lib/restaurantTableSync'

type PrismaDb = PrismaClient | Prisma.TransactionClient

function formatOrderLocation(tableId: string | null | undefined, tableName: string | null | undefined) {
  if (!tableId) return 'Takeaway'
  return tableName?.trim() ? `Table ${tableName.trim()}` : 'Table'
}

function buildDishSaleTransactionDescription(order: {
  items: Array<{ dishId: string; dishName: string; qty: number }>
  tableId: string | null
  tableName: string | null
}) {
  const dishSummary = order.items
    .map((item) => `${item.dishName} [${item.dishId}] x${item.qty}`)
    .join(', ')

  return `DishSale: ${dishSummary} · ${formatOrderLocation(order.tableId, order.tableName)}`
}

export async function finalizeRestaurantOrderPayment(
  db: PrismaDb,
  params: {
    restaurantId: string
    branchId: string
    sourceDeviceId?: string | null
    orderId: string
    paymentMethod?: string | null
    arCustomerName?: string | null
    arCustomerPhone?: string | null
    paidAt?: Date
  },
) {
  const currentOrder = await db.restaurantOrder.findFirst({
    where: {
      id: params.orderId,
      restaurantId: params.restaurantId,
      branchId: params.branchId,
    },
    include: { items: { where: { status: 'ACTIVE' } } },
  })

  console.log('[finalize] order lookup', params.orderId, 'status:', currentOrder?.status ?? 'NOT_FOUND', 'items:', currentOrder?.items?.length ?? 0)

  if (!currentOrder) {
    throw new Error('Order not found')
  }

  if (currentOrder.status === 'PAID') {
    // Order is already PAID — backfill any missing dish sales (idempotent per-dish guard).
    console.log('[finalize] order already PAID — backfilling any missing dish sales, items:', currentOrder.items.length)
    if (currentOrder.items.length > 0) {
      await recordDishSalesForPaidOrder(db, {
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        sourceDeviceId: params.sourceDeviceId,
        orderId: params.orderId,
        paymentMethod: params.paymentMethod || currentOrder.paymentMethod || 'Cash',
        saleDate: currentOrder.paidAt ?? params.paidAt ?? new Date(),
        businessDate: currentOrder.businessDate ?? null,
        items: currentOrder.items.map((item) => ({
          orderItemId: item.id,
          dishId: item.dishId,
          dishName: item.dishName,
          dishVariantId: item.dishVariantId,
          dishVariantName: item.dishVariantName,
          dishPrice: item.dishPrice,
          qty: item.qty,
          branchId: item.branchId,
        })),
      })
    }
    return currentOrder
  }

  await syncRestaurantOrderTotals(db, params.orderId)

  const paidAt = params.paidAt ?? new Date()
  const normalizedPaymentMethod = params.paymentMethod || currentOrder.paymentMethod || 'Cash'

  const paymentUpdate = await db.restaurantOrder.updateMany({
    where: {
      id: params.orderId,
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      status: { in: [...ACTIVE_RESTAURANT_ORDER_STATUSES] },
    },
    data: {
      status: 'PAID',
      paymentMethod: normalizedPaymentMethod,
      paidAt,
      // Only written when supplied, so a re-sync from a client that doesn't send
      // them can never blank out the customer already recorded against the tab.
      ...(params.arCustomerName ? { arCustomerName: params.arCustomerName } : {}),
      ...(params.arCustomerPhone ? { arCustomerPhone: params.arCustomerPhone } : {}),
      canceledAt: null,
      cancelReason: null,
    },
  })

  if (paymentUpdate.count === 0) {
    return (await db.restaurantOrder.findFirst({
      where: { id: params.orderId, restaurantId: params.restaurantId, branchId: params.branchId },
      include: { items: { where: { status: 'ACTIVE' } } },
    })) ?? currentOrder
  }

  const paidOrder = await db.restaurantOrder.findFirst({
    where: { id: params.orderId, restaurantId: params.restaurantId, branchId: params.branchId },
    include: { items: { where: { status: 'ACTIVE' } } },
  })

  if (!paidOrder) {
    throw new Error('Order not found after payment update')
  }

  await recordDishSalesForPaidOrder(db, {
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    sourceDeviceId: params.sourceDeviceId,
    orderId: params.orderId,
    paymentMethod: normalizedPaymentMethod,
    saleDate: paidAt,
    businessDate: currentOrder.businessDate ?? null,
    items: currentOrder.items.map((item) => ({
      orderItemId: item.id,
      dishId: item.dishId,
      dishName: item.dishName,
      dishVariantId: item.dishVariantId,
      dishVariantName: item.dishVariantName,
      dishPrice: item.dishPrice,
      qty: item.qty,
      branchId: item.branchId,
    })),
  })

  // Revenue is booked per station that SOLD each dish, not the till's station:
  // an Amstel (Parking Bar) sold from a Little Taipei terminal must land in
  // Parking Bar's transactions. One journal entry per involved station.
  //
  // The per-station split is taken from the DishSale rows just recorded above —
  // the single source of truth for attribution — NOT a fresh dish lookup.
  // Re-deriving it separately is exactly how the ledger drifted away from the
  // sales: a dish that couldn't be resolved fell back to the till and lumped the
  // whole order under one station. Grouping off DishSale keeps the Transactions
  // page and the sales identical by construction.
  //
  // `reference` ties every entry to its order and makes the booking idempotent —
  // a retried or racing finalize is a no-op once the order has been booked.
  const orderRef = `order:${params.orderId}`
  const alreadyBooked = await db.journalEntry.count({
    where: { restaurantId: params.restaurantId, reference: orderRef, deletedAt: null },
  })
  if (alreadyBooked === 0) {
    const orderDishSales = await db.dishSale.findMany({
      where: { orderId: params.orderId, deletedAt: null },
      select: { dishId: true, orderItemId: true, branchId: true },
    })
    const branchByItemId = new Map(
      orderDishSales.filter((sale) => sale.orderItemId).map((sale) => [sale.orderItemId, sale.branchId]),
    )
    const branchByDishId = new Map(orderDishSales.map((sale) => [sale.dishId, sale.branchId]))

    const itemsByBranch = new Map<string, typeof currentOrder.items>()
    for (const item of currentOrder.items) {
      // Prefer the exact order-item match; fall back to dish-level. An item with
      // no DishSale (its dish couldn't be resolved, so no sale was recorded) is
      // skipped here too — the journal never books revenue the sales don't carry.
      const itemBranchId = branchByItemId.get(item.id) ?? branchByDishId.get(item.dishId)
      if (!itemBranchId) {
        console.warn(`[finalize] no DishSale for item ${item.id} (dish ${item.dishId}) — skipping revenue booking (order: ${params.orderId})`)
        continue
      }
      const group = itemsByBranch.get(itemBranchId)
      if (group) group.push(item)
      else itemsByBranch.set(itemBranchId, [item])
    }

    // The hotel buffet is settled by the hotel, not by the guest at the table,
    // so its revenue must not land in the till alongside the cash. Splitting the
    // station's lines by settlement books the buffet as 'Credit' — which
    // resolveSettlementAccountSpec turns into Accounts Receivable (1200) — while
    // whatever the guest actually paid for keeps the order's real tender. An
    // order of buffet plus add-ons therefore books two entries per station:
    // the receivable, and the add-ons at Cash/MoMo.
    //
    // The category is only a guard confirming a name match really is the buffet
    // dish, so the lookup is skipped entirely unless a line already matches by
    // name — which keeps the ordinary order at zero extra queries.
    const buffetDishIds = [...new Set(
      currentOrder.items
        .filter((item) => isHotelBuffetLine(params.restaurantId, item.dishName))
        .map((item) => item.dishId),
    )]
    const dishCategories = new Map<string, string | null>(
      buffetDishIds.length
        ? (await db.dish.findMany({
            where: { id: { in: buffetDishIds } },
            select: { id: true, category: true },
          })).map((dish) => [dish.id, dish.category])
        : [],
    )
    const settlesOnCredit = (item: { dishId: string; dishName: string }) =>
      isHotelBuffetLine(params.restaurantId, item.dishName, dishCategories.get(item.dishId))

    for (const [itemsBranchId, branchItems] of itemsByBranch) {
      const onCredit = branchItems.filter(settlesOnCredit)
      const atTheTill = branchItems.filter((item) => !settlesOnCredit(item))

      for (const [tender, tenderItems] of [
        [normalizedPaymentMethod, atTheTill],
        ['Credit', onCredit],
      ] as const) {
        if (!tenderItems.length) continue

        const branchAmount = calculateRestaurantOrderTotals(
          tenderItems.map((item) => ({ dishPrice: Number(item.dishPrice), qty: Number(item.qty) }))
        ).totalAmount

        await recordJournalEntry(db, {
          restaurantId: params.restaurantId,
          branchId: itemsBranchId,
          date: paidOrder.paidAt ?? paidAt,
          businessDate: currentOrder.businessDate ?? null,
          description: buildDishSaleTransactionDescription({
            items: tenderItems.map((item) => ({ dishId: item.dishId, dishName: item.dishName, qty: item.qty })),
            tableId: currentOrder.tableId,
            tableName: currentOrder.tableName,
          }),
          reference: orderRef,
          amount: branchAmount,
          direction: 'in',
          accountName: 'DishSale',
          categoryType: 'income',
          paymentMethod: tender,
        })
      }
    }
  }

  if (currentOrder.tableId) {
    await db.restaurantTable.updateMany({
      where: {
        id: currentOrder.tableId,
        restaurantId: params.restaurantId,
        branchId: params.branchId,
      },
      data: { status: 'available' },
    })
    await enqueueRestaurantTableSync(db, currentOrder.tableId, params.restaurantId, params.sourceDeviceId)
  }

  await enqueueOrderSync(db, params.orderId, params.restaurantId, params.branchId, params.sourceDeviceId)

  return paidOrder
}
