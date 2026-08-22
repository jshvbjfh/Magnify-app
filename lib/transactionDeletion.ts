import type { Prisma, PrismaClient } from '@prisma/client'

import { enqueueSyncChange } from '@/lib/syncOutbox'
import { enqueueRestaurantTableSync } from '@/lib/restaurantTableSync'

type PrismaDb = PrismaClient | Prisma.TransactionClient

export type TransactionDeletionRefusal = 'not_found' | 'stock_entry'

export type TransactionDeletionResult =
  | {
      ok: true
      // What actually went. A sale rung up across two stations books two
      // entries, so this is rarely 1 even though the manager clicked one row.
      entriesDeleted: number
      salesDeleted: number
      orderNumber: string | null
      orderDeleted: boolean
      stockRestored: boolean
    }
  | { ok: false; reason: TransactionDeletionRefusal; message: string }

function orderIdFromReference(reference: string | null | undefined) {
  const value = String(reference ?? '')
  return value.startsWith('order:') ? value.slice('order:'.length) : null
}

// The reference recordReceivableCollection stamps on the entry that clears a
// credit sale. Deleting the sale has to take its collection with it, or the
// money would stay on the books with nothing owing behind it.
function receivableReferenceForOrder(orderId: string) {
  return `AR-${orderId.slice(-8).toUpperCase()}`
}

/**
 * Delete a transaction and everything the app derived from it — for ever.
 *
 * This is the deliberate opposite of the soft-delete used elsewhere. A manager
 * reaches for it when a sale should never have existed (a bill rung up twice, a
 * table settled by mistake), and what they mean by "delete" is that no report
 * may ever show it again. Half the sales reports read DishSale directly and do
 * not filter deletedAt, so a soft delete would leave the sale showing in exactly
 * the places the manager was trying to clear.
 *
 * An order-backed entry therefore unwinds the whole settlement, not just the
 * ledger row:
 *   - the stock the dishes consumed goes back on the shelf, batch by batch;
 *   - the DishSale rows go, so sales-by-dish and the P&L lose them;
 *   - every journal entry raised for the order goes, including the per-station
 *     split and any receivable collected against it;
 *   - the order itself goes, freeing its table so it can be rung up again.
 *
 * MEP portions are the one thing that cannot come back: the sale records what a
 * batch-cooked portion cost, never how many it drew, so there is nothing to add
 * back to the dish's prepared count. A kitchen re-punching the bill will cook
 * against the recipe instead, which is the safe direction to be wrong in.
 */
export async function deleteTransactionForever(
  db: PrismaDb,
  params: { restaurantId: string; entryId: string; sourceDeviceId?: string | null },
): Promise<TransactionDeletionResult> {
  const entry = await db.journalEntry.findFirst({
    where: { id: params.entryId, restaurantId: params.restaurantId },
    select: { id: true, reference: true },
  })

  if (!entry) {
    return { ok: false, reason: 'not_found', message: 'That transaction no longer exists.' }
  }

  // A stock purchase's entry is the receipt for stock that is still on the
  // shelf. Deleting it here would drop the expense and leave the batch, so it
  // is refused and pointed at the screen that can unwind both together.
  const linkedPurchase = await db.inventoryPurchase.findFirst({
    where: { journalEntryId: entry.id },
    select: { id: true },
  })
  if (linkedPurchase) {
    return { ok: false, reason: 'stock_entry', message: 'Delete this from Stock Entries — it still holds stock.' }
  }

  const orderId = orderIdFromReference(entry.reference)

  if (!orderId) {
    await db.journalEntry.delete({ where: { id: entry.id } })
    return { ok: true, entriesDeleted: 1, salesDeleted: 0, orderNumber: null, orderDeleted: false, stockRestored: false }
  }

  const order = await db.restaurantOrder.findFirst({
    where: { id: orderId, restaurantId: params.restaurantId },
    select: { id: true, branchId: true, tableId: true, orderNumber: true },
  })

  const sales = await db.dishSale.findMany({
    where: { orderId, restaurantId: params.restaurantId },
    select: { id: true, branchId: true },
  })
  const saleIds = sales.map((sale) => sale.id)

  let stockRestored = false

  if (saleIds.length > 0) {
    // Put each batch back exactly where it was drawn from. The usage ledger is
    // the only record of which layer paid for the dish, so it is read before it
    // is cleared — restoring the item's total without the layers would leave
    // FIFO costing the next sale off batches that are empty on paper.
    const usage = await db.inventoryBatchUsageLedger.findMany({
      where: { sourceType: 'dishSale', sourceId: { in: saleIds } },
      select: { id: true, purchaseId: true, quantityConsumed: true },
    })

    for (const row of usage) {
      const quantity = Number(row.quantityConsumed || 0)
      if (!(quantity > 0)) continue
      try {
        const purchase = await db.inventoryPurchase.update({
          where: { id: row.purchaseId },
          data: { remainingQuantity: { increment: quantity } },
        })
        stockRestored = true
        await enqueueSyncChange(db, {
          restaurantId: params.restaurantId,
          branchId: purchase.branchId,
          entityType: 'inventoryPurchase',
          entityId: purchase.id,
          operation: 'upsert',
          sourceDeviceId: params.sourceDeviceId ?? null,
          payload: purchase,
        })
      } catch {
        // The batch has since been deleted — nothing left to credit it back to.
      }
    }

    if (usage.length > 0) {
      await db.inventoryBatchUsageLedger.deleteMany({
        where: { sourceType: 'dishSale', sourceId: { in: saleIds } },
      })
    }

    // The on-hand counter is decremented on every sale, FIFO or not, so it is
    // restored from the sale's own ingredient lines rather than from the ledger
    // — which only exists when batches are tracked. Summed per ingredient so an
    // item used by several dishes on the bill takes one write.
    const consumedLines = await db.dishSaleIngredient.findMany({
      where: { dishSaleId: { in: saleIds } },
      select: { ingredientId: true, quantityUsed: true },
    })
    const quantityByIngredient = new Map<string, number>()
    for (const line of consumedLines) {
      const quantity = Number(line.quantityUsed || 0)
      if (!(quantity > 0)) continue
      quantityByIngredient.set(line.ingredientId, (quantityByIngredient.get(line.ingredientId) ?? 0) + quantity)
    }

    for (const [ingredientId, quantity] of quantityByIngredient) {
      try {
        const ingredient = await db.inventoryItem.update({
          where: { id: ingredientId },
          data: { quantity: { increment: quantity } },
        })
        stockRestored = true
        await enqueueSyncChange(db, {
          restaurantId: params.restaurantId,
          branchId: ingredient.branchId,
          entityType: 'inventoryItem',
          entityId: ingredient.id,
          operation: 'upsert',
          sourceDeviceId: params.sourceDeviceId ?? null,
          payload: ingredient,
        })
      } catch {
        // The ingredient itself is gone — there is nothing to put back.
      }
    }

    await db.dishSale.deleteMany({ where: { id: { in: saleIds } } })

    for (const sale of sales) {
      await enqueueSyncChange(db, {
        restaurantId: params.restaurantId,
        branchId: sale.branchId,
        entityType: 'dishSale',
        entityId: sale.id,
        operation: 'delete',
        sourceDeviceId: params.sourceDeviceId ?? null,
        payload: { id: sale.id },
      })
    }
  }

  // Every entry the settlement raised, not only the row that was clicked: the
  // per-station revenue split, and the collection if the tab was on credit.
  const relatedEntries = await db.journalEntry.findMany({
    where: {
      restaurantId: params.restaurantId,
      reference: { in: [`order:${orderId}`, receivableReferenceForOrder(orderId)] },
    },
    select: { id: true },
  })
  const entryIds = [...new Set([entry.id, ...relatedEntries.map((row) => row.id)])]
  const removedEntries = await db.journalEntry.deleteMany({ where: { id: { in: entryIds } } })

  if (order) {
    // Cascades the order's items and its kitchen tickets. The dish sales above
    // had to go first — their orderId is nullable, so the database would have
    // orphaned them here instead of removing them.
    await db.restaurantOrder.delete({ where: { id: order.id } })

    await enqueueSyncChange(db, {
      restaurantId: params.restaurantId,
      branchId: order.branchId,
      entityType: 'restaurantOrder',
      entityId: order.id,
      operation: 'delete',
      sourceDeviceId: params.sourceDeviceId ?? null,
      payload: { id: order.id },
    })

    if (order.tableId) {
      await db.restaurantTable.updateMany({
        where: { id: order.tableId, restaurantId: params.restaurantId },
        data: { status: 'available' },
      })
      await enqueueRestaurantTableSync(db, order.tableId, params.restaurantId, params.sourceDeviceId ?? null)
    }
  }

  return {
    ok: true,
    entriesDeleted: removedEntries.count,
    salesDeleted: saleIds.length,
    orderNumber: order?.orderNumber ?? null,
    orderDeleted: Boolean(order),
    stockRestored,
  }
}
