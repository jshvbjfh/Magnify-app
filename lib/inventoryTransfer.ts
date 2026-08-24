import type { Prisma, PrismaClient } from '@prisma/client'

type PrismaDb = PrismaClient | Prisma.TransactionClient

function roundQuantity(value: number) {
  return Math.round((Number(value) + Number.EPSILON) * 1_000_000) / 1_000_000
}

export class InsufficientTransferStockError extends Error {
  constructor(
    public readonly ingredientName: string,
    public readonly requested: number,
    public readonly available: number,
    public readonly unit: string,
  ) {
    super(`Only ${available} ${unit} of ${ingredientName} available to import.`)
    this.name = 'InsufficientTransferStockError'
  }
}

export type TransferIngredientStockParams = {
  restaurantId: string
  /** The station receiving the stock. */
  toBranchId: string
  /** The InventoryItem being moved. Under shared stock this row lives on the main station. */
  ingredientId: string
  quantity: number
  /** Who asked for it, for the audit trail. */
  requestedByName?: string | null
}

/**
 * Move stock from the shared pool onto one station, so that station consumes it
 * before the pool.
 *
 * WHAT A TRANSFER IS. Not a purchase and not a consumption — the restaurant
 * owns exactly the same stock, at the same cost, before and after. All that
 * changes is which station a FIFO batch sits on. So this RELOCATES batches
 * rather than creating or destroying them:
 *
 *   - a batch that fits entirely inside the request has its branchId moved
 *   - the batch that straddles the boundary is split in two
 *
 * A split conserves every figure across the pair — quantityPurchased,
 * remainingQuantity and totalCost each sum to what the single row held. That is
 * what keeps purchase totals, stock value and the inventory-movement report
 * correct without any of them needing to know transfers exist. Inventing a
 * purchase row at the destination would have inflated "bought this period" by
 * the transferred amount, on a period where nothing was bought.
 *
 * COST TRAVELS WITH THE STOCK. Each moved batch keeps its own unitCost, so a
 * dish cooked at the station is costed at what the restaurant actually paid for
 * that particular delivery. Re-valuing at an average here would quietly rewrite
 * food cost for every dish made from imported stock.
 *
 * OLDEST FIRST. The batches taken are the ones the pool would have used next,
 * so importing never lets a station skip ahead of the queue and leave older
 * stock to expire in the store.
 *
 * The item's own quantity is deliberately untouched: under shared stock that
 * figure is the restaurant's total, and the restaurant still holds every unit.
 */
export async function transferIngredientStock(
  db: PrismaDb,
  params: TransferIngredientStockParams,
) {
  const quantity = roundQuantity(Number(params.quantity))
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('Import quantity must be greater than 0.')
  }

  const ingredient = await db.inventoryItem.findFirst({
    where: { id: params.ingredientId, restaurantId: params.restaurantId, deletedAt: null },
    select: { id: true, name: true, unit: true, branchId: true },
  })
  if (!ingredient) throw new Error('That item is not on this restaurant’s stock list.')

  // Importing onto the station the stock already sits on is a no-op that would
  // otherwise split batches for nothing.
  if (ingredient.branchId === params.toBranchId) {
    throw new Error('That stock is already held by this station.')
  }

  // Everything the pool holds that is not already on the receiving station.
  // Oldest first, so an import takes what would have been used next anyway.
  const layers = await db.inventoryPurchase.findMany({
    where: {
      restaurantId: params.restaurantId,
      ingredientId: params.ingredientId,
      remainingQuantity: { gt: 0 },
      deletedAt: null,
      NOT: { branchId: params.toBranchId },
    },
    orderBy: [{ purchasedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  })

  const available = roundQuantity(
    layers.reduce((sum, layer) => sum + Number(layer.remainingQuantity || 0), 0),
  )
  if (available + Number.EPSILON < quantity) {
    throw new InsufficientTransferStockError(ingredient.name, quantity, available, ingredient.unit)
  }

  // Each entry is a real batch that moved, kept so the station can be told
  // exactly what it now holds — an import is attached to batches, not to a
  // loose quantity, and when those batches run dry the station imports again
  // and gets the next ones in the queue.
  const moved: Array<{
    purchaseId: string
    batchId: string | null
    supplier: string | null
    purchasedAt: Date
    expiresAt: Date | null
    quantity: number
    unitCost: number
    split: boolean
  }> = []
  let remaining = quantity

  for (const layer of layers) {
    if (remaining <= Number.EPSILON) break

    const layerRemaining = roundQuantity(Number(layer.remainingQuantity || 0))
    if (layerRemaining <= Number.EPSILON) continue

    const take = roundQuantity(Math.min(layerRemaining, remaining))
    remaining = roundQuantity(remaining - take)
    const unitCost = Number(layer.unitCost || 0)

    if (take >= layerRemaining - Number.EPSILON) {
      // The whole of what is left moves, so the row simply changes station. No
      // new row, nothing to conserve, and the batch keeps its identity and
      // history.
      await db.inventoryPurchase.update({
        where: { id: layer.id },
        data: { branchId: params.toBranchId },
      })
      moved.push({
        purchaseId: layer.id,
        batchId: layer.batchId,
        supplier: layer.supplier,
        purchasedAt: layer.purchasedAt,
        expiresAt: layer.expiresAt,
        quantity: take,
        unitCost,
        split: false,
      })
      continue
    }

    // A partial move splits the batch. Every figure is apportioned so the pair
    // still sums to what the single row held — otherwise the split would read
    // as a fresh purchase in every report that totals them.
    const purchasedTotal = Number(layer.quantityPurchased || 0)
    const costTotal = Number(layer.totalCost || 0)
    // Apportion on what is being moved out of what is still there, so a batch
    // already part-consumed splits its ORIGINAL cost in the same proportion.
    const share = layerRemaining > 0 ? take / layerRemaining : 0
    const movedPurchased = roundQuantity(purchasedTotal * share)
    const movedCost = roundQuantity(costTotal * share)

    await db.inventoryPurchase.update({
      where: { id: layer.id },
      data: {
        remainingQuantity: roundQuantity(layerRemaining - take),
        quantityPurchased: roundQuantity(purchasedTotal - movedPurchased),
        totalCost: roundQuantity(costTotal - movedCost),
      },
    })

    const created = await db.inventoryPurchase.create({
      data: {
        restaurantId: params.restaurantId,
        branchId: params.toBranchId,
        ingredientId: params.ingredientId,
        // The half that moved carries the same batch identity, supplier and
        // dates, because it is physically the same delivery.
        batchId: layer.batchId,
        supplier: layer.supplier,
        purchaseQuantity: null,
        purchaseUnit: layer.purchaseUnit,
        unitsPerPurchaseUnit: layer.unitsPerPurchaseUnit,
        purchaseUnitCost: layer.purchaseUnitCost,
        quantityPurchased: movedPurchased,
        remainingQuantity: take,
        unitCost,
        totalCost: movedCost,
        paymentMethod: layer.paymentMethod,
        paidAt: layer.paidAt,
        purchasedAt: layer.purchasedAt,
        expiresAt: layer.expiresAt,
        // Deliberately NOT linked to the original journal entry: the money was
        // booked once, when it was bought, and pointing a second row at that
        // entry would make one purchase look like two.
        journalEntryId: null,
      },
      select: { id: true },
    })
    moved.push({
      purchaseId: created.id,
      batchId: layer.batchId,
      supplier: layer.supplier,
      purchasedAt: layer.purchasedAt,
      expiresAt: layer.expiresAt,
      quantity: take,
      unitCost,
      split: true,
    })
  }

  const movedQuantity = roundQuantity(moved.reduce((sum, m) => sum + m.quantity, 0))
  const movedCost = roundQuantity(moved.reduce((sum, m) => sum + m.quantity * m.unitCost, 0))

  // The audit trail. quantityDelta is zero on purpose — the restaurant's total
  // did not move, only its location did — and the reason carries the detail so
  // a stock take can see who pulled what onto which station.
  await db.inventoryAdjustmentLog.create({
    data: {
      restaurantId: params.restaurantId,
      branchId: params.toBranchId,
      ingredientId: params.ingredientId,
      adjustmentType: 'transfer_in',
      quantityDelta: 0,
      itemQuantityBefore: 0,
      itemQuantityAfter: 0,
      reason: `Imported ${movedQuantity} ${ingredient.unit} of ${ingredient.name} from the main store${
        params.requestedByName ? ` by ${params.requestedByName}` : ''
      }`,
    },
  })

  return {
    ingredientId: params.ingredientId,
    ingredientName: ingredient.name,
    unit: ingredient.unit,
    toBranchId: params.toBranchId,
    quantity: movedQuantity,
    totalCost: movedCost,
    batchesMoved: moved.length,
    // The batches the station now holds, so it can be told what it actually
    // took rather than just a number.
    batches: moved,
  }
}

/**
 * How much imported stock a station still holds, per item.
 *
 * This is what the station consumes before the shared pool, so it is also what
 * the "imported stock used up" alert watches: the moment it reaches zero the
 * station has fallen back on the pool, and whoever imported wants to know.
 */
export async function getImportedStockForBranch(
  db: PrismaDb,
  params: { restaurantId: string; branchId: string },
) {
  const rows = await db.inventoryPurchase.groupBy({
    by: ['ingredientId'],
    where: {
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      remainingQuantity: { gt: 0 },
      deletedAt: null,
    },
    _sum: { remainingQuantity: true },
  })
  return rows.map((row) => ({
    ingredientId: row.ingredientId,
    remaining: roundQuantity(Number(row._sum.remainingQuantity || 0)),
  }))
}
