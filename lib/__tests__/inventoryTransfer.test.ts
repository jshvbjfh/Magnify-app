/**
 * Tests for importing stock from the shared pool onto one station.
 *
 * A transfer moves no money and creates no stock — the restaurant holds exactly
 * the same units at exactly the same cost before and after, on a different
 * station. These pin down that conservation, because the failure mode is silent:
 * a transfer that invents quantity or cost shows up as a purchase nobody made,
 * in a period where nothing was bought, and only surfaces at stock take.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { InsufficientTransferStockError, transferIngredientStock } from '../inventoryTransfer'

const MAIN = 'branch-main'
const STATION = 'branch-grill'
const RESTAURANT = 'rest-1'
const ITEM = 'item-flour'

type Layer = {
  id: string
  branchId: string
  batchId: string | null
  supplier: string | null
  purchaseUnit: string | null
  unitsPerPurchaseUnit: number | null
  purchaseUnitCost: number | null
  quantityPurchased: number
  remainingQuantity: number
  unitCost: number
  totalCost: number
  paymentMethod: string
  paidAt: Date | null
  purchasedAt: Date
  expiresAt: Date | null
}

function layer(over: Partial<Layer> & { id: string; purchasedAt: Date }): Layer {
  const quantityPurchased = over.quantityPurchased ?? 10
  const unitCost = over.unitCost ?? 100
  return {
    branchId: MAIN,
    batchId: `batch-${over.id}`,
    supplier: 'Acme',
    purchaseUnit: 'sack',
    unitsPerPurchaseUnit: 10,
    purchaseUnitCost: unitCost * 10,
    quantityPurchased,
    remainingQuantity: over.remainingQuantity ?? quantityPurchased,
    unitCost,
    totalCost: over.totalCost ?? quantityPurchased * unitCost,
    paymentMethod: 'Cash',
    paidAt: null,
    expiresAt: null,
    ...over,
  }
}

function makeDb(layers: Layer[]) {
  const updates: Array<{ id: string; data: Record<string, unknown> }> = []
  const creates: Array<Record<string, unknown>> = []
  const logs: Array<Record<string, unknown>> = []
  return {
    updates, creates, logs,
    inventoryItem: {
      findFirst: vi.fn().mockResolvedValue({
        id: ITEM, name: 'Flour', unit: 'kg', branchId: MAIN,
      }),
    },
    inventoryPurchase: {
      findMany: vi.fn().mockImplementation(async () =>
        layers.filter((l) => l.remainingQuantity > 0 && l.branchId !== STATION)
      ),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => {
        updates.push({ id: where.id, data })
        const found = layers.find((l) => l.id === where.id)
        if (found) Object.assign(found, data)
        return found
      }),
      create: vi.fn().mockImplementation(async ({ data }: any) => {
        creates.push(data)
        return { id: `created-${creates.length}` }
      }),
    },
    inventoryAdjustmentLog: {
      create: vi.fn().mockImplementation(async ({ data }: any) => { logs.push(data); return data }),
    },
  } as any
}

describe('transferIngredientStock', () => {
  beforeEach(() => vi.clearAllMocks())

  it('moves a whole batch by relocating it, creating no new row', async () => {
    // Nothing was bought, so nothing may look like a purchase. Changing the
    // station on the existing row is the entire operation.
    const layers = [layer({ id: 'a', purchasedAt: new Date('2026-08-01'), quantityPurchased: 10 })]
    const db = makeDb(layers)

    const result = await transferIngredientStock(db, {
      restaurantId: RESTAURANT, toBranchId: STATION, ingredientId: ITEM, quantity: 10,
    })

    expect(db.creates).toHaveLength(0)
    expect(db.updates).toEqual([{ id: 'a', data: { branchId: STATION } }])
    expect(result.quantity).toBe(10)
    expect(result.batchesMoved).toBe(1)
  })

  it('conserves quantity and cost when a batch is split', async () => {
    // The half that stays and the half that moves must still sum to what the
    // one row held, or every report that totals purchases gains stock nobody
    // bought.
    const layers = [layer({
      id: 'a', purchasedAt: new Date('2026-08-01'),
      quantityPurchased: 10, remainingQuantity: 10, unitCost: 100, totalCost: 1000,
    })]
    const db = makeDb(layers)

    await transferIngredientStock(db, {
      restaurantId: RESTAURANT, toBranchId: STATION, ingredientId: ITEM, quantity: 4,
    })

    const kept = db.updates[0].data as any
    const movedRow = db.creates[0] as any

    expect(kept.remainingQuantity + movedRow.remainingQuantity).toBe(10)
    expect(kept.quantityPurchased + movedRow.quantityPurchased).toBe(10)
    expect(kept.totalCost + movedRow.totalCost).toBe(1000)
    // Cost travels with the stock, unchanged.
    expect(movedRow.unitCost).toBe(100)
    expect(movedRow.branchId).toBe(STATION)
  })

  it('apportions the original cost when a part-used batch is split', async () => {
    // 6 of 10 already gone. Moving 3 of the remaining 6 takes half of what is
    // left, so half of the row's surviving figures go with it.
    const layers = [layer({
      id: 'a', purchasedAt: new Date('2026-08-01'),
      quantityPurchased: 10, remainingQuantity: 6, unitCost: 100, totalCost: 1000,
    })]
    const db = makeDb(layers)

    await transferIngredientStock(db, {
      restaurantId: RESTAURANT, toBranchId: STATION, ingredientId: ITEM, quantity: 3,
    })

    const kept = db.updates[0].data as any
    const movedRow = db.creates[0] as any
    expect(kept.remainingQuantity).toBe(3)
    expect(movedRow.remainingQuantity).toBe(3)
    expect(kept.quantityPurchased + movedRow.quantityPurchased).toBe(10)
    expect(kept.totalCost + movedRow.totalCost).toBe(1000)
  })

  it('takes the oldest batches first, so nothing jumps the queue', async () => {
    const layers = [
      layer({ id: 'old', purchasedAt: new Date('2026-08-01'), quantityPurchased: 5, unitCost: 100 }),
      layer({ id: 'new', purchasedAt: new Date('2026-08-10'), quantityPurchased: 5, unitCost: 200 }),
    ]
    const db = makeDb(layers)

    const result = await transferIngredientStock(db, {
      restaurantId: RESTAURANT, toBranchId: STATION, ingredientId: ITEM, quantity: 7,
    })

    // All of the old batch relocates, then 2 splits off the newer one.
    expect(db.updates[0]).toEqual({ id: 'old', data: { branchId: STATION } })
    expect(result.quantity).toBe(7)
    expect(result.batchesMoved).toBe(2)
    // Each moved batch kept its own price: 5 at 100 plus 2 at 200.
    expect(result.totalCost).toBe(5 * 100 + 2 * 200)
  })

  it('keeps each moved batch attached to its own identity', async () => {
    const layers = [layer({
      id: 'a', purchasedAt: new Date('2026-08-01'), batchId: 'DELIVERY-77', supplier: 'Acme',
    })]
    const db = makeDb(layers)

    const result = await transferIngredientStock(db, {
      restaurantId: RESTAURANT, toBranchId: STATION, ingredientId: ITEM, quantity: 10,
    })

    expect(result.batches[0].batchId).toBe('DELIVERY-77')
    expect(result.batches[0].supplier).toBe('Acme')
  })

  it('refuses to import more than the pool holds', async () => {
    const layers = [layer({ id: 'a', purchasedAt: new Date('2026-08-01'), quantityPurchased: 3 })]
    const db = makeDb(layers)

    await expect(transferIngredientStock(db, {
      restaurantId: RESTAURANT, toBranchId: STATION, ingredientId: ITEM, quantity: 5,
    })).rejects.toBeInstanceOf(InsufficientTransferStockError)

    // Nothing moved — a failed import must leave the pool exactly as it was.
    expect(db.updates).toHaveLength(0)
    expect(db.creates).toHaveLength(0)
  })

  it('rejects a zero or negative quantity', async () => {
    const db = makeDb([layer({ id: 'a', purchasedAt: new Date('2026-08-01') })])
    await expect(transferIngredientStock(db, {
      restaurantId: RESTAURANT, toBranchId: STATION, ingredientId: ITEM, quantity: 0,
    })).rejects.toThrow(/greater than 0/)
  })

  it('refuses to import stock onto the station that already holds it', async () => {
    const db = makeDb([layer({ id: 'a', purchasedAt: new Date('2026-08-01') })])
    db.inventoryItem.findFirst.mockResolvedValue({
      id: ITEM, name: 'Flour', unit: 'kg', branchId: STATION,
    })
    await expect(transferIngredientStock(db, {
      restaurantId: RESTAURANT, toBranchId: STATION, ingredientId: ITEM, quantity: 1,
    })).rejects.toThrow(/already held by this station/)
  })

  it('writes an audit line that moves no quantity', async () => {
    // The restaurant's total did not change, only where it sits, so a delta
    // here would read as stock appearing from nowhere.
    const db = makeDb([layer({ id: 'a', purchasedAt: new Date('2026-08-01') })])
    await transferIngredientStock(db, {
      restaurantId: RESTAURANT, toBranchId: STATION, ingredientId: ITEM, quantity: 10,
      requestedByName: 'Aloys',
    })
    expect(db.logs[0]).toMatchObject({
      adjustmentType: 'transfer_in',
      quantityDelta: 0,
      branchId: STATION,
    })
    expect(String(db.logs[0].reason)).toContain('Aloys')
  })

  it('never points a moved half at the original journal entry', async () => {
    // The money was booked once, when it was bought. Two rows pointing at one
    // entry would read as the purchase having happened twice.
    const db = makeDb([layer({ id: 'a', purchasedAt: new Date('2026-08-01'), quantityPurchased: 10 })])
    await transferIngredientStock(db, {
      restaurantId: RESTAURANT, toBranchId: STATION, ingredientId: ITEM, quantity: 4,
    })
    expect((db.creates[0] as any).journalEntryId).toBeNull()
  })
})
