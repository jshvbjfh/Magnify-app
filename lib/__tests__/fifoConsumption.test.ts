/**
 * Unit tests for the FIFO batch dequeue logic in lib/inventoryConsumption.ts.
 *
 * Tests focus on:
 *   - InsufficientFifoStockError when batch total < required
 *   - InsufficientInventoryStockError in non-FIFO mode
 *   - Single-batch exact consumption (allocations, cost)
 *   - Multi-batch drain: oldest batch exhausted first, remainder taken from next
 *   - Floating-point safety (EPSILON tolerance prevents false shortfalls)
 *
 * All DB interactions are satisfied by a fake db object — no real DB connection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  consumeIngredientStock,
  InsufficientFifoStockError,
  InsufficientInventoryStockError,
} from '../inventoryConsumption'

// ---------------------------------------------------------------------------
// Module mocks (needed to bypass server-only imports and side-effect modules)
// ---------------------------------------------------------------------------

vi.mock('../syncOutbox', () => ({
  enqueueSyncChange: vi.fn().mockResolvedValue(undefined),
  getSyncDeviceId: () => 'test-device',
  isRestaurantWideSyncEntity: () => false,
  serializeOutboxPayload: (p: unknown) => JSON.stringify(p),
  GLOBAL_SYNC_SCOPE_ID: 'global',
  CLOUD_SYNC_TARGET: 'cloud',
  SYNC_OUTBOX_MAX_ATTEMPTS: 8,
}))

vi.mock('../fifoRollout', () => ({
  getRestaurantFifoRuntimeAvailability: vi.fn().mockReturnValue(true),
  getRestaurantFifoAvailability: vi.fn().mockReturnValue(true),
}))

vi.mock('../fifoCosting', () => ({
  getActiveFifoUnitCost: vi.fn().mockReturnValue(500),
}))

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const BASE_PARAMS = {
  billingUserId: 'user-1',
  restaurantId: 'rest-1',
  branchId: 'branch-1',
  ingredientId: 'ing-1',
  fifoEnabled: true,
  sourceType: 'dishSale' as const,
  sourceId: 'order-1',
  consumedAt: new Date('2026-05-11T10:00:00Z'),
}

function makeIngredient(overrides: Partial<{
  id: string; name: string; unit: string; unitCost: number; quantity: number
}> = {}) {
  return { id: 'ing-1', name: 'Tomato', unit: 'kg', unitCost: 500, quantity: 10, ...overrides }
}

/** Build a purchase batch row with remainingQuantity and unitCost. */
function makeBatch(id: string, remainingQuantity: number, unitCost: number, purchasedAt = '2026-01-01') {
  return {
    id,
    batchId: id,
    remainingQuantity,
    unitCost,
    purchasedAt: new Date(purchasedAt),
    createdAt: new Date(purchasedAt),
  }
}

/**
 * Build a fake Prisma-shaped db object.
 * inventoryPurchase.update simulates the { decrement } Prisma operator.
 */
function makeMockDb(ingredient: ReturnType<typeof makeIngredient>, batches: ReturnType<typeof makeBatch>[]) {
  // Clone batches so update mutations are reflected correctly across loop iterations
  const mutable = batches.map((b) => ({ ...b, remainingQuantity: Number(b.remainingQuantity) }))
  const byId = new Map(mutable.map((b) => [b.id, b]))

  return {
    inventoryItem: {
      findFirst: vi.fn().mockResolvedValue(ingredient),
      update: vi.fn().mockImplementation(({ where, data }: any) => {
        const updated = { ...ingredient, ...data }
        return Promise.resolve(updated)
      }),
    },
    inventoryPurchase: {
      findMany: vi.fn().mockResolvedValue(mutable),
      update: vi.fn().mockImplementation(({ where, data }: any) => {
        const batch = byId.get(where.id)!
        const decrement = Number(data.remainingQuantity?.decrement ?? 0)
        batch.remainingQuantity = Math.round((batch.remainingQuantity - decrement) * 1000) / 1000
        return Promise.resolve({ ...batch })
      }),
    },
    inventoryBatchUsageLedger: {
      create: vi.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ id: `ledger-${data.purchaseId}`, ...data }),
      ),
    },
  }
}

// ---------------------------------------------------------------------------
// Tests: InsufficientFifoStockError
// ---------------------------------------------------------------------------

describe('consumeIngredientStock — FIFO mode', () => {
  it('throws InsufficientFifoStockError when all batches are exhausted', async () => {
    const ingredient = makeIngredient()
    const batches = [makeBatch('b1', 1, 500)]
    const db = makeMockDb(ingredient, batches)

    await expect(
      consumeIngredientStock(db as any, { ...BASE_PARAMS, quantity: 5, fifoEnabled: true }),
    ).rejects.toBeInstanceOf(InsufficientFifoStockError)
  })

  it('InsufficientFifoStockError carries the correct metadata', async () => {
    const ingredient = makeIngredient({ name: 'Onion', unit: 'kg' })
    const db = makeMockDb(ingredient, [makeBatch('b1', 0.5, 300)])

    let error: InsufficientFifoStockError | null = null
    try {
      await consumeIngredientStock(db as any, { ...BASE_PARAMS, quantity: 2, fifoEnabled: true })
    } catch (e) {
      error = e as InsufficientFifoStockError
    }

    expect(error).toBeInstanceOf(InsufficientFifoStockError)
    expect(error!.ingredientId).toBe('ing-1')
    expect(error!.ingredientName).toBe('Onion')
    expect(error!.requiredQuantity).toBe(2)
    expect(error!.availableQuantity).toBeCloseTo(0.5)
    expect(error!.unit).toBe('kg')
  })

  it('throws when available is exactly 0', async () => {
    const db = makeMockDb(makeIngredient(), [])
    await expect(
      consumeIngredientStock(db as any, { ...BASE_PARAMS, quantity: 1, fifoEnabled: true }),
    ).rejects.toBeInstanceOf(InsufficientFifoStockError)
  })

  // ---------------------------------------------------------------------------
  // Single-batch consumption
  // ---------------------------------------------------------------------------

  it('consumes from a single batch and returns one allocation', async () => {
    const ingredient = makeIngredient()
    const db = makeMockDb(ingredient, [makeBatch('b1', 5, 600)])

    const result = await consumeIngredientStock(db as any, {
      ...BASE_PARAMS, quantity: 3, fifoEnabled: true,
    })

    expect(result.allocations).toHaveLength(1)
    expect(result.allocations[0].purchaseId).toBe('b1')
    expect(result.allocations[0].quantityConsumed).toBeCloseTo(3)
    expect(result.allocations[0].unitCost).toBe(600)
    expect(result.allocations[0].totalCost).toBeCloseTo(1800) // 3 × 600
    expect(result.totalCost).toBeCloseTo(1800)
    expect(result.fifoEnabled).toBe(true)
    expect(result.quantityConsumed).toBeCloseTo(3)
  })

  it('drains the full batch when quantity equals remaining', async () => {
    const db = makeMockDb(makeIngredient(), [makeBatch('b1', 2, 1000)])

    const result = await consumeIngredientStock(db as any, {
      ...BASE_PARAMS, quantity: 2, fifoEnabled: true,
    })

    expect(result.allocations).toHaveLength(1)
    expect(result.allocations[0].quantityConsumed).toBeCloseTo(2)
    expect(result.totalCost).toBeCloseTo(2000)
  })

  // ---------------------------------------------------------------------------
  // Multi-batch (FIFO order) consumption
  // ---------------------------------------------------------------------------

  it('drains oldest batch first, then takes remainder from next batch', async () => {
    const ingredient = makeIngredient()
    const batches = [
      makeBatch('b1', 2, 400, '2026-01-01'), // oldest — drained first
      makeBatch('b2', 5, 800, '2026-02-01'), // newer
    ]
    const db = makeMockDb(ingredient, batches)

    // Request 4 kg → take 2 from b1 (exhausted), 2 from b2
    const result = await consumeIngredientStock(db as any, {
      ...BASE_PARAMS, quantity: 4, fifoEnabled: true,
    })

    expect(result.allocations).toHaveLength(2)

    const a1 = result.allocations[0]
    expect(a1.purchaseId).toBe('b1')
    expect(a1.quantityConsumed).toBeCloseTo(2)
    expect(a1.totalCost).toBeCloseTo(800) // 2 × 400

    const a2 = result.allocations[1]
    expect(a2.purchaseId).toBe('b2')
    expect(a2.quantityConsumed).toBeCloseTo(2)
    expect(a2.totalCost).toBeCloseTo(1600) // 2 × 800

    expect(result.totalCost).toBeCloseTo(2400) // 800 + 1600
  })

  it('skips zero-remaining batches silently', async () => {
    const batches = [
      makeBatch('b1', 0, 500, '2026-01-01'), // empty — should be skipped
      makeBatch('b2', 3, 700, '2026-02-01'),
    ]
    const db = makeMockDb(makeIngredient(), batches)

    const result = await consumeIngredientStock(db as any, {
      ...BASE_PARAMS, quantity: 2, fifoEnabled: true,
    })

    // Should have only one allocation — from b2
    expect(result.allocations).toHaveLength(1)
    expect(result.allocations[0].purchaseId).toBe('b2')
  })

  it('stops consuming once quantity is satisfied (does not over-consume)', async () => {
    const batches = [
      makeBatch('b1', 5, 300, '2026-01-01'),
      makeBatch('b2', 5, 600, '2026-02-01'),
    ]
    const db = makeMockDb(makeIngredient(), batches)

    const result = await consumeIngredientStock(db as any, {
      ...BASE_PARAMS, quantity: 3, fifoEnabled: true,
    })

    // Only 3 needed — should be satisfied entirely from b1
    expect(result.allocations).toHaveLength(1)
    expect(result.allocations[0].purchaseId).toBe('b1')
    expect(result.totalCost).toBeCloseTo(900) // 3 × 300
  })

  // ---------------------------------------------------------------------------
  // Floating-point safety
  // ---------------------------------------------------------------------------

  it('handles floating-point quantities without spurious shortfall errors', async () => {
    // 3 × 0.333 kg dishes = 0.999 kg consumed. Available = 1.0 kg.
    // Without EPSILON rounding this can be treated as insufficient.
    const db = makeMockDb(makeIngredient(), [makeBatch('b1', 1.0, 500)])

    await expect(
      consumeIngredientStock(db as any, { ...BASE_PARAMS, quantity: 0.999, fifoEnabled: true }),
    ).resolves.toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Tests: non-FIFO (simple quantity tracking)
// ---------------------------------------------------------------------------

describe('consumeIngredientStock — non-FIFO mode', () => {
  it('throws InsufficientInventoryStockError when ingredient quantity < requested', async () => {
    const ingredient = makeIngredient({ quantity: 0.5 })
    const db = makeMockDb(ingredient, [])

    await expect(
      consumeIngredientStock(db as any, { ...BASE_PARAMS, quantity: 2, fifoEnabled: false }),
    ).rejects.toBeInstanceOf(InsufficientInventoryStockError)
  })

  it('InsufficientInventoryStockError carries correct metadata', async () => {
    const ingredient = makeIngredient({ name: 'Butter', unit: 'g', quantity: 100 })
    const db = makeMockDb(ingredient, [])

    let error: InsufficientInventoryStockError | null = null
    try {
      await consumeIngredientStock(db as any, { ...BASE_PARAMS, quantity: 500, fifoEnabled: false })
    } catch (e) {
      error = e as InsufficientInventoryStockError
    }

    expect(error).toBeInstanceOf(InsufficientInventoryStockError)
    expect(error!.ingredientName).toBe('Butter')
    expect(error!.unit).toBe('g')
    expect(error!.requiredQuantity).toBe(500)
    expect(error!.availableQuantity).toBeCloseTo(100)
  })

  it('returns empty allocations (no batch tracking) on success', async () => {
    const ingredient = makeIngredient({ quantity: 10, unitCost: 400 })
    const db = makeMockDb(ingredient, [])

    const result = await consumeIngredientStock(db as any, {
      ...BASE_PARAMS, quantity: 3, fifoEnabled: false,
    })

    expect(result.allocations).toHaveLength(0)
    expect(result.fifoEnabled).toBe(false)
    expect(result.totalCost).toBeCloseTo(1200) // 3 × 400
  })

  it('calculates totalCost as quantity × unitCost in non-FIFO mode', async () => {
    const ingredient = makeIngredient({ quantity: 20, unitCost: 750 })
    const db = makeMockDb(ingredient, [])

    const result = await consumeIngredientStock(db as any, {
      ...BASE_PARAMS, quantity: 4, fifoEnabled: false,
    })

    expect(result.totalCost).toBeCloseTo(3000) // 4 × 750
  })
})

// ---------------------------------------------------------------------------
// Tests: imported stock is consumed before the shared pool
// ---------------------------------------------------------------------------

describe('consumeIngredientStock — imported stock first', () => {
  /** A batch that also carries the station it sits on. */
  function batchOnBranch(id: string, remainingQuantity: number, unitCost: number, branchId: string, purchasedAt: string) {
    return { ...makeBatch(id, remainingQuantity, unitCost, purchasedAt), branchId }
  }

  it('drains what the station imported before touching the pool', async () => {
    // The imported batch is NEWER than the pool's, so plain FIFO would reach
    // for the pool first. Importing is a deliberate act — the station reserved
    // that stock for its service and expects to work off it.
    const ingredient = makeIngredient()
    const batches = [
      batchOnBranch('pool-old', 10, 100, 'branch-main', '2026-01-01'),
      batchOnBranch('imported', 4, 250, 'branch-1', '2026-06-01'),
    ]
    const db = makeMockDb(ingredient, batches)

    const result = await consumeIngredientStock(db as any, { ...BASE_PARAMS, quantity: 3 })

    expect(result.allocations).toHaveLength(1)
    expect(result.allocations[0].purchaseId).toBe('imported')
    expect(result.totalCost).toBe(3 * 250)
  })

  it('falls back to the pool once the imported stock is used up', async () => {
    // The station is never cut off: an import can only ever change the order,
    // so running out mid-service still sells.
    const ingredient = makeIngredient()
    const batches = [
      batchOnBranch('pool-old', 10, 100, 'branch-main', '2026-01-01'),
      batchOnBranch('imported', 4, 250, 'branch-1', '2026-06-01'),
    ]
    const db = makeMockDb(ingredient, batches)

    const result = await consumeIngredientStock(db as any, { ...BASE_PARAMS, quantity: 6 })

    expect(result.allocations.map((a) => a.purchaseId)).toEqual(['imported', 'pool-old'])
    // 4 imported at 250, then 2 from the pool at 100.
    expect(result.totalCost).toBe(4 * 250 + 2 * 100)
  })

  it('keeps FIFO inside the imported stock itself', async () => {
    const ingredient = makeIngredient()
    const batches = [
      batchOnBranch('imported-old', 2, 250, 'branch-1', '2026-05-01'),
      batchOnBranch('imported-new', 5, 300, 'branch-1', '2026-06-01'),
      batchOnBranch('pool', 10, 100, 'branch-main', '2026-01-01'),
    ]
    const db = makeMockDb(ingredient, batches)

    const result = await consumeIngredientStock(db as any, { ...BASE_PARAMS, quantity: 4 })

    expect(result.allocations.map((a) => a.purchaseId)).toEqual(['imported-old', 'imported-new'])
  })

  it('behaves exactly as before when the station has imported nothing', async () => {
    // Every restaurant is in this state until someone imports for the first
    // time, so this is the case that must not move.
    const ingredient = makeIngredient()
    const batches = [
      batchOnBranch('b1', 3, 100, 'branch-main', '2026-01-01'),
      batchOnBranch('b2', 5, 200, 'branch-main', '2026-02-01'),
    ]
    const db = makeMockDb(ingredient, batches)

    const result = await consumeIngredientStock(db as any, { ...BASE_PARAMS, quantity: 5 })

    expect(result.allocations.map((a) => a.purchaseId)).toEqual(['b1', 'b2'])
    expect(result.totalCost).toBe(3 * 100 + 2 * 200)
  })
})
