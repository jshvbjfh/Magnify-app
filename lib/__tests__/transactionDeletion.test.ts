/**
 * Unit tests for deleting a transaction for ever.
 *
 * "Delete" here means what a manager means by it: the entry is gone from every
 * report, not hidden from one. A settled bill is the hard case — one row on the
 * Transactions page, but a whole settlement underneath it — so these tests pin
 * down that the unwind is symmetric with the payment that created it:
 *  - the batch a dish drew from gets its quantity back, and so does the item's
 *    on-hand count;
 *  - the DishSale rows go, so sales-by-dish and the P&L lose them;
 *  - every journal entry the order raised goes, including the per-station split
 *    and the collection if the tab was on credit;
 *  - the order goes and its table comes free, so the bill can be rung up again.
 *
 * A stock purchase is refused outright: its entry is the receipt for stock that
 * is still on the shelf.
 *
 * All Prisma calls are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../syncOutbox', () => ({
  enqueueSyncChange: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../restaurantTableSync', () => ({
  enqueueRestaurantTableSync: vi.fn().mockResolvedValue(undefined),
}))

import { deleteTransactionForever } from '../transactionDeletion'
import { enqueueSyncChange } from '../syncOutbox'
import { enqueueRestaurantTableSync } from '../restaurantTableSync'

const RESTAURANT = 'rest-1'
const ORDER = 'order-abc12345'
const TILL = 'branch-till'

type DbOverrides = {
  entry?: Record<string, unknown> | null
  purchaseLinked?: boolean
  order?: Record<string, unknown> | null
  sales?: Array<{ id: string; branchId: string }>
  usage?: Array<{ id: string; purchaseId: string; quantityConsumed: number }>
  consumedLines?: Array<{ ingredientId: string; quantityUsed: number }>
  relatedEntries?: Array<{ id: string }>
}

function makeDb(overrides: DbOverrides = {}) {
  const db = {
    journalEntry: {
      findFirst: vi.fn().mockResolvedValue(
        overrides.entry === undefined
          ? { id: 'entry-1', reference: `order:${ORDER}` }
          : overrides.entry,
      ),
      findMany: vi.fn().mockResolvedValue(overrides.relatedEntries ?? [{ id: 'entry-1' }, { id: 'entry-2' }]),
      delete: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockImplementation(({ where }: any) => ({ count: where.id.in.length })),
    },
    inventoryPurchase: {
      findFirst: vi.fn().mockResolvedValue(overrides.purchaseLinked ? { id: 'purchase-1' } : null),
      update: vi.fn().mockImplementation(({ where }: any) => ({ id: where.id, branchId: TILL })),
    },
    restaurantOrder: {
      findFirst: vi.fn().mockResolvedValue(
        overrides.order === undefined
          ? { id: ORDER, branchId: TILL, tableId: 'table-12', orderNumber: 'A-0007' }
          : overrides.order,
      ),
      delete: vi.fn().mockResolvedValue({}),
    },
    dishSale: {
      findMany: vi.fn().mockResolvedValue(overrides.sales ?? [{ id: 'sale-1', branchId: TILL }]),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    dishSaleIngredient: {
      findMany: vi.fn().mockResolvedValue(overrides.consumedLines ?? []),
    },
    inventoryBatchUsageLedger: {
      findMany: vi.fn().mockResolvedValue(overrides.usage ?? []),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    inventoryItem: {
      update: vi.fn().mockImplementation(({ where }: any) => ({ id: where.id, branchId: TILL })),
    },
    restaurantTable: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  }
  return db as unknown as Parameters<typeof deleteTransactionForever>[0] & typeof db
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('deleteTransactionForever', () => {
  it('refuses an entry that no longer exists', async () => {
    const db = makeDb({ entry: null })

    const result = await deleteTransactionForever(db, { restaurantId: RESTAURANT, entryId: 'entry-1' })

    expect(result).toEqual({ ok: false, reason: 'not_found', message: 'That transaction no longer exists.' })
    expect(db.journalEntry.delete).not.toHaveBeenCalled()
  })

  it('refuses a stock purchase — the batch it paid for is still on the shelf', async () => {
    const db = makeDb({ entry: { id: 'entry-1', reference: null }, purchaseLinked: true })

    const result = await deleteTransactionForever(db, { restaurantId: RESTAURANT, entryId: 'entry-1' })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('stock_entry')
    expect(db.journalEntry.delete).not.toHaveBeenCalled()
    expect(db.inventoryPurchase.update).not.toHaveBeenCalled()
  })

  it('deletes a manual entry on its own, touching no sale or stock', async () => {
    const db = makeDb({ entry: { id: 'entry-1', reference: 'manual' } })

    const result = await deleteTransactionForever(db, { restaurantId: RESTAURANT, entryId: 'entry-1' })

    expect(result).toMatchObject({ ok: true, entriesDeleted: 1, salesDeleted: 0, orderDeleted: false, stockRestored: false })
    expect(db.journalEntry.delete).toHaveBeenCalledWith({ where: { id: 'entry-1' } })
    expect(db.dishSale.deleteMany).not.toHaveBeenCalled()
    expect(db.restaurantOrder.delete).not.toHaveBeenCalled()
  })

  it('unwinds a settled bill: stock back, sales gone, every entry gone, order gone, table free', async () => {
    const db = makeDb({
      sales: [{ id: 'sale-1', branchId: TILL }, { id: 'sale-2', branchId: 'branch-bar' }],
      usage: [
        { id: 'use-1', purchaseId: 'purchase-9', quantityConsumed: 2 },
        { id: 'use-2', purchaseId: 'purchase-9', quantityConsumed: 0.5 },
      ],
      consumedLines: [
        { ingredientId: 'ing-1', quantityUsed: 2 },
        { ingredientId: 'ing-1', quantityUsed: 0.5 },
        { ingredientId: 'ing-2', quantityUsed: 1 },
      ],
      // The per-station split plus the receivable collected against the tab.
      relatedEntries: [{ id: 'entry-1' }, { id: 'entry-2' }, { id: 'entry-ar' }],
    })

    const result = await deleteTransactionForever(db, { restaurantId: RESTAURANT, entryId: 'entry-1' })

    expect(result).toMatchObject({ ok: true, salesDeleted: 2, orderNumber: 'A-0007', orderDeleted: true, stockRestored: true })

    // Each batch layer is credited back the exact quantity it gave up.
    expect(db.inventoryPurchase.update).toHaveBeenCalledWith({
      where: { id: 'purchase-9' },
      data: { remainingQuantity: { increment: 2 } },
    })
    expect(db.inventoryPurchase.update).toHaveBeenCalledWith({
      where: { id: 'purchase-9' },
      data: { remainingQuantity: { increment: 0.5 } },
    })
    expect(db.inventoryBatchUsageLedger.deleteMany).toHaveBeenCalled()

    // On-hand counts are summed per ingredient, so an item used by two dishes
    // on the same bill comes back in one write rather than two.
    expect(db.inventoryItem.update).toHaveBeenCalledTimes(2)
    expect(db.inventoryItem.update).toHaveBeenCalledWith({
      where: { id: 'ing-1' },
      data: { quantity: { increment: 2.5 } },
    })
    expect(db.inventoryItem.update).toHaveBeenCalledWith({
      where: { id: 'ing-2' },
      data: { quantity: { increment: 1 } },
    })

    expect(db.dishSale.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['sale-1', 'sale-2'] } } })

    // Both revenue entries and the receivable collection, in one sweep.
    expect(db.journalEntry.findMany).toHaveBeenCalledWith({
      where: {
        restaurantId: RESTAURANT,
        reference: { in: [`order:${ORDER}`, 'AR-ABC12345'] },
      },
      select: { id: true },
    })
    expect(db.journalEntry.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['entry-1', 'entry-2', 'entry-ar'] } },
    })
    expect(result.ok && result.entriesDeleted).toBe(3)

    expect(db.restaurantOrder.delete).toHaveBeenCalledWith({ where: { id: ORDER } })
    expect(db.restaurantTable.updateMany).toHaveBeenCalledWith({
      where: { id: 'table-12', restaurantId: RESTAURANT },
      data: { status: 'available' },
    })
    expect(enqueueRestaurantTableSync).toHaveBeenCalled()

    // Connected tills and tablets are told to drop the order and its sales,
    // otherwise the next pull would put the bill straight back.
    const deleteOps = vi.mocked(enqueueSyncChange).mock.calls
      .map(([, args]) => args)
      .filter((args) => args.operation === 'delete')
      .map((args) => `${args.entityType}:${args.entityId}`)
    expect(deleteOps).toContain(`restaurantOrder:${ORDER}`)
    expect(deleteOps).toContain('dishSale:sale-1')
    expect(deleteOps).toContain('dishSale:sale-2')
  })

  it('still clears the ledger when the order row has already gone', async () => {
    const db = makeDb({ order: null, sales: [], relatedEntries: [{ id: 'entry-1' }] })

    const result = await deleteTransactionForever(db, { restaurantId: RESTAURANT, entryId: 'entry-1' })

    expect(result).toMatchObject({ ok: true, orderDeleted: false, salesDeleted: 0 })
    expect(db.journalEntry.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['entry-1'] } } })
    expect(db.restaurantOrder.delete).not.toHaveBeenCalled()
  })
})
