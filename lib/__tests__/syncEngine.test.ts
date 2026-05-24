/**
 * Unit tests for lib/syncEngine.ts — targeting every structural fix
 * applied in this codebase (C1, C2, C-branchskip, M1, M2, M3, joinCode).
 *
 * All Prisma DB calls are mocked via a fake db object. No DB connection needed.
 * All external module imports (syncOutbox, accounting) are vi.mock'd.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { applyResolvedSyncChange, applyIncomingSyncChanges } from '../syncEngine'
import type { SyncChangeEnvelope } from '../syncOutbox'

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../syncOutbox', () => ({
  getSyncDeviceId: () => 'test-device',
  logSyncConflict: vi.fn().mockResolvedValue(undefined),
  isRestaurantWideSyncEntity: (t: string) =>
    ['restaurant', 'restaurantBranch', 'pricingPlan'].includes(t),
  serializeOutboxPayload: (p: unknown) => JSON.stringify(p),
  GLOBAL_SYNC_SCOPE_ID: 'global',
  CLOUD_SYNC_TARGET: 'cloud',
  SYNC_OUTBOX_MAX_ATTEMPTS: 8,
  RESTAURANT_WIDE_ENTITY_TYPES: new Set(['restaurant', 'restaurantBranch', 'pricingPlan']),
  BRANCH_REQUIRED_ENTITY_TYPES: new Set(['dish', 'inventoryItem', 'employee']),
}))

vi.mock('../accounting', () => ({
  ensureAccount: vi.fn().mockResolvedValue({ id: 'acc-1' }),
  ensureCoreCategories: vi.fn().mockResolvedValue(undefined),
}))

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Returns a fresh Prisma mock with all needed models. Override per-model for specific tests. */
function makeMockDb(overrides: Record<string, any> = {}): any {
  const defaults = {
    restaurant: {
      findFirst: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: 'rest-1' }),
      update: vi.fn().mockResolvedValue({ id: 'rest-1' }),
    },
    branch: {
      findFirst: vi.fn().mockResolvedValue({ id: 'branch-1' }),
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({}),
      upsert: vi.fn().mockResolvedValue({ id: 'branch-1' }),
    },
    restaurantTable: {
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({}),
    },
    pricingPlan: {
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({}),
    },
    dish: {
      findFirst: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ id: 'dish-1' }),
      deleteMany: vi.fn().mockResolvedValue({}),
    },
    dishIngredient: {
      deleteMany: vi.fn().mockResolvedValue({}),
      upsert: vi.fn().mockResolvedValue({}),
    },
    employee: {
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({}),
    },
    inventoryItem: {
      findFirst: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({}),
    },
    inventoryPurchase: {
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({}),
    },
    inventoryAdjustmentLog: {
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({}),
    },
    inventoryBatchUsageLedger: {
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({}),
    },
    wasteLog: {
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({}),
    },
    shift: {
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({}),
    },
    dishSale: {
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({}),
    },
    transaction: {
      upsert: vi.fn().mockResolvedValue({}),
    },
    restaurantOrder: {
      upsert: vi.fn().mockResolvedValue({ id: 'order-1' }),
      deleteMany: vi.fn().mockResolvedValue({}),
    },
    orderItem: {
      deleteMany: vi.fn().mockResolvedValue({}),
      createMany: vi.fn().mockResolvedValue({}),
    },
    syncOutbox: {
      findFirst: vi.fn().mockResolvedValue(null), // no pending conflict
      upsert: vi.fn().mockResolvedValue({}),
    },
    account: {
      findFirst: vi.fn().mockResolvedValue({ id: 'acc-1' }),
      upsert: vi.fn().mockResolvedValue({ id: 'acc-1' }),
    },
  }

  // Deep-merge overrides so callers can replace individual methods
  const result: any = { ...defaults }
  for (const [model, methods] of Object.entries(overrides)) {
    result[model] = { ...defaults[model as keyof typeof defaults], ...methods }
  }
  return result
}

let idSeq = 0
function makeChange(
  entityType: string,
  operation: 'upsert' | 'delete' = 'upsert',
  payload: Record<string, any> = {},
  overrides: Partial<SyncChangeEnvelope> = {},
): SyncChangeEnvelope {
  return {
    mutationId: `mut-${++idSeq}`,
    scopeId: 'scope-1',
    restaurantId: 'rest-1',
    branchId: 'branch-1',
    entityType,
    entityId: `eid-${idSeq}`,
    operation,
    payload,
    sourceDeviceId: 'device-1',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// applyResolvedSyncChange tests
// ---------------------------------------------------------------------------

describe('applyResolvedSyncChange', () => {
  // ── restaurant ─────────────────────────────────────────────────────────────

  describe('restaurant', () => {
    it('displaces a conflicting joinCode row before upserting (joinCode fix)', async () => {
      const db = makeMockDb({
        restaurant: {
          findFirst: vi.fn().mockResolvedValue({ id: 'ghost-rest-id' }),
          upsert: vi.fn().mockResolvedValue({}),
          update: vi.fn().mockResolvedValue({}),
        },
      })

      const change = makeChange('restaurant', 'upsert', {
        id: 'new-rest-id',
        name: 'My Restaurant',
        ownerId: 'user-1',
        joinCode: 'ABC123',
      }, { entityId: 'new-rest-id' })

      await applyResolvedSyncChange(db, change)

      // Must have looked up the conflict by joinCode excluding self
      expect(db.restaurant.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ joinCode: 'ABC123' }),
        }),
      )

      // Must have displaced the conflicting row's joinCode
      expect(db.restaurant.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ghost-rest-id' },
          data: expect.objectContaining({
            joinCode: expect.stringMatching(/^DISPLACED-/),
          }),
        }),
      )

      // Must still have upserted the incoming restaurant
      expect(db.restaurant.upsert).toHaveBeenCalled()
    })

    it('skips displacement and upserts cleanly when no joinCode conflict exists', async () => {
      const db = makeMockDb({
        restaurant: {
          findFirst: vi.fn().mockResolvedValue(null),
          upsert: vi.fn().mockResolvedValue({}),
          update: vi.fn().mockResolvedValue({}),
        },
      })

      const change = makeChange('restaurant', 'upsert', {
        id: 'rest-id',
        name: 'My Restaurant',
        ownerId: 'user-1',
        joinCode: 'XYZ999',
      }, { entityId: 'rest-id' })

      await applyResolvedSyncChange(db, change)

      expect(db.restaurant.update).not.toHaveBeenCalled()
      expect(db.restaurant.upsert).toHaveBeenCalled()
    })

    it('skips joinCode conflict lookup when payload has no joinCode', async () => {
      const db = makeMockDb()

      const change = makeChange('restaurant', 'upsert', {
        id: 'rest-id',
        name: 'No-code Restaurant',
        ownerId: 'user-1',
        // joinCode intentionally absent
      }, { entityId: 'rest-id' })

      await applyResolvedSyncChange(db, change)

      expect(db.restaurant.findFirst).not.toHaveBeenCalled()
      expect(db.restaurant.update).not.toHaveBeenCalled()
    })
  })

  describe('branch', () => {
    it('persists branch presentation fields needed by the QR menu', async () => {
      const db = makeMockDb({
        branch: {
          findFirst: vi.fn().mockResolvedValue({ id: 'branch-1' }),
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn().mockResolvedValue({}),
          upsert: vi.fn().mockResolvedValue({ id: 'branch-1' }),
        },
      })

      const change = makeChange('branch', 'upsert', {
        id: 'branch-1',
        restaurantId: 'rest-1',
        name: 'Bar',
        code: 'BAR',
        isMain: false,
        isActive: true,
        billHeader: 'High 5ive',
        qrMenuHeroImageUrl: 'https://example.com/hero.jpg',
      }, {
        entityId: 'branch-1',
        branchId: null,
      })

      await applyResolvedSyncChange(db, change)

      expect(db.branch.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'branch-1' },
          update: expect.objectContaining({
            billHeader: 'High 5ive',
            qrMenuHeroImageUrl: 'https://example.com/hero.jpg',
          }),
          create: expect.objectContaining({
            billHeader: 'High 5ive',
            qrMenuHeroImageUrl: 'https://example.com/hero.jpg',
          }),
        }),
      )
    })
  })

  // ── dish ───────────────────────────────────────────────────────────────────

  describe('dish', () => {
    it('upserts to the existing conflicting-name row id (C1)', async () => {
      const db = makeMockDb({
        dish: {
          findFirst: vi.fn().mockResolvedValue({ id: 'existing-dish-id' }),
          upsert: vi.fn().mockResolvedValue({}),
          deleteMany: vi.fn().mockResolvedValue({}),
        },
      })

      const change = makeChange('dish', 'upsert', {
        id: 'incoming-dish-id',
        name: 'Jollof Rice',
        userId: 'user-1',
        restaurantId: 'rest-1',
        branchId: 'branch-1',
        sellingPrice: 25,
      })

      await applyResolvedSyncChange(db, change, { remapUserId: 'user-1' })

      // Must target the existing row's id, not the incoming one
      expect(db.dish.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'existing-dish-id' } }),
      )
    })

    it('upserts to incoming id when there is no name conflict', async () => {
      const db = makeMockDb()

      const change = makeChange('dish', 'upsert', {
        id: 'fresh-dish-id',
        name: 'Fried Rice',
        userId: 'user-1',
        restaurantId: 'rest-1',
        branchId: 'branch-1',
        sellingPrice: 30,
      }, { entityId: 'fresh-dish-id' })

      await applyResolvedSyncChange(db, change, { remapUserId: 'user-1' })

      expect(db.dish.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'fresh-dish-id' } }),
      )
    })

    it('throws when no branchId can be resolved (C-branchskip)', async () => {
      const db = makeMockDb({
        branch: {
          findFirst: vi.fn().mockResolvedValue(null), // DB has no branches
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn().mockResolvedValue({}),
          upsert: vi.fn().mockResolvedValue({}),
        },
      })

      // payload has no branchId, restaurant has no branches → should throw
      const change = makeChange('dish', 'upsert', {
        id: 'dish-id',
        name: 'Soup',
        userId: 'user-1',
        restaurantId: 'rest-1',
        sellingPrice: 15,
      }, { branchId: null })

      await expect(applyResolvedSyncChange(db, change)).rejects.toThrow(
        /no resolvable branchId/,
      )
    })

    it('dish C1: conflict query includes restaurantId and branchId so same-name dishes in different restaurants/branches are not merged', async () => {
      // Dish unique constraint is @@unique([userId, restaurantId, branchId, name]).
      // The C1 findFirst must scope by all four fields so a dish named "Rice" in
      // restaurant A is never merged with one in restaurant B.
      const findFirst = vi.fn().mockResolvedValue(null) // no conflict in this scope
      const db = makeMockDb({
        dish: {
          findFirst,
          upsert: vi.fn().mockResolvedValue({}),
          deleteMany: vi.fn().mockResolvedValue({}),
        },
      })

      const change = makeChange('dish', 'upsert', {
        id: 'dish-rest-b',
        name: 'Jollof Rice',
        userId: 'user-1',
        restaurantId: 'rest-B',
        branchId: 'branch-B',
        sellingPrice: 25,
      }, { branchId: 'branch-B' })

      await applyResolvedSyncChange(db, change, { remapUserId: 'user-1' })

      // The conflict query must scope by restaurantId AND branchId, not just (userId, name)
      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            restaurantId: 'rest-B',
            branchId: 'branch-B',
            name: 'Jollof Rice',
          }),
        }),
      )
      // No conflict found → upsert with the incoming id
      expect(db.dish.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'dish-rest-b' } }),
      )
    })
  })

  // ── dishIngredient ─────────────────────────────────────────────────────────

  describe('dishIngredient', () => {
    it('derives dishId and ingredientId from entityId when payload is empty (M2)', async () => {
      const db = makeMockDb()

      const change = makeChange('dishIngredient', 'delete', {}, {
        entityId: 'dish-abc:ingredient-xyz',
      })

      await applyResolvedSyncChange(db, change)

      expect(db.dishIngredient.deleteMany).toHaveBeenCalledWith({
        where: { dishId: 'dish-abc', inventoryItemId: 'ingredient-xyz' },
      })
    })

    it('prefers payload dishId/ingredientId over entityId parsing (M2)', async () => {
      const db = makeMockDb()

      const change = makeChange('dishIngredient', 'delete', {
        dishId: 'payload-dish',
        ingredientId: 'payload-ing',
      }, {
        entityId: 'fallback-dish:fallback-ing',
      })

      await applyResolvedSyncChange(db, change)

      expect(db.dishIngredient.deleteMany).toHaveBeenCalledWith({
        where: { dishId: 'payload-dish', inventoryItemId: 'payload-ing' },
      })
    })

    it('throws when entityId has no colon and payload is empty (M2)', async () => {
      const db = makeMockDb()

      const change = makeChange('dishIngredient', 'delete', {}, {
        entityId: 'no-separator-here',
      })

      await expect(applyResolvedSyncChange(db, change)).rejects.toThrow(
        /cannot resolve dishId\/inventoryItemId/,
      )
    })
  })

  // ── inventoryItem ──────────────────────────────────────────────────────────

  describe('inventoryItem', () => {
    it('upserts to existing conflicting-name row id (C1)', async () => {
      const db = makeMockDb({
        inventoryItem: {
          findFirst: vi.fn().mockResolvedValue({ id: 'existing-item-id' }),
          upsert: vi.fn().mockResolvedValue({}),
          deleteMany: vi.fn().mockResolvedValue({}),
        },
      })

      const change = makeChange('inventoryItem', 'upsert', {
        id: 'incoming-item-id',
        name: 'Tomatoes',
        userId: 'user-1',
        restaurantId: 'rest-1',
        branchId: 'branch-1',
        unit: 'kg',
        currentStock: 10,
        reorderPoint: 2,
        costPerUnit: 5,
        trackingMode: 'simple',
      })

      await applyResolvedSyncChange(db, change, { remapUserId: 'user-1' })

      expect(db.inventoryItem.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'existing-item-id' } }),
      )
    })
  })

  // ── restaurantOrder ────────────────────────────────────────────────────────

  describe('restaurantOrder', () => {
    const baseOrderPayload = {
      id: 'order-1',
      restaurantId: 'rest-1',
      branchId: 'branch-1',
      tableName: 'T1',
      orderNumber: 1,
      status: 'ACTIVE',
      subtotalAmount: 50,
      vatAmount: 0,
      totalAmount: 50,
      createdById: 'user-1',
      createdByName: 'Staff',
    }

    it('filters out items with missing id and only creates valid ones (M3)', async () => {
      const db = makeMockDb()

      const change = makeChange('restaurantOrder', 'upsert', {
        ...baseOrderPayload,
        items: [
          { id: 'item-good', dishId: 'dish-1', dishName: 'Rice', dishPrice: 25, qty: 1, kitchenStatus: 'new', status: 'ACTIVE' },
          { dishId: 'dish-2', dishName: 'Chicken', dishPrice: 25, qty: 1 }, // missing id
        ],
      }, { entityId: 'order-1' })

      await applyResolvedSyncChange(db, change)

      // deleteMany must have run (validItems.length > 0)
      expect(db.orderItem.deleteMany).toHaveBeenCalled()

      // createMany must only contain the valid item
      expect(db.orderItem.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [expect.objectContaining({ id: 'item-good' })],
        }),
      )

      const [createManyArg] = db.orderItem.createMany.mock.calls[0]
      expect(createManyArg.data).toHaveLength(1)
    })

    it('skips deleteMany and createMany when all items have missing ids (M3)', async () => {
      const db = makeMockDb()

      const change = makeChange('restaurantOrder', 'upsert', {
        ...baseOrderPayload,
        items: [
          { dishId: 'dish-1', dishName: 'Rice', dishPrice: 25, qty: 1 }, // no id
        ],
      }, { entityId: 'order-1' })

      await applyResolvedSyncChange(db, change)

      // Neither should have been called
      expect(db.orderItem.deleteMany).not.toHaveBeenCalled()
      expect(db.orderItem.createMany).not.toHaveBeenCalled()
    })

    it('runs deleteMany and createMany normally when all items have valid ids', async () => {
      const db = makeMockDb()

      const change = makeChange('restaurantOrder', 'upsert', {
        ...baseOrderPayload,
        items: [
          { id: 'item-1', dishId: 'dish-1', dishName: 'Rice', dishPrice: 25, qty: 1, kitchenStatus: 'new', status: 'ACTIVE' },
          { id: 'item-2', dishId: 'dish-2', dishName: 'Chicken', dishPrice: 25, qty: 1, kitchenStatus: 'new', status: 'ACTIVE' },
        ],
      }, { entityId: 'order-1' })

      await applyResolvedSyncChange(db, change)

      expect(db.orderItem.deleteMany).toHaveBeenCalled()
      const [createManyArg] = db.orderItem.createMany.mock.calls[0]
      expect(createManyArg.data).toHaveLength(2)
    })
  })

  // ── default / M1 ──────────────────────────────────────────────────────────

  describe('default case', () => {
    it('throws for an unknown entityType (M1)', async () => {
      const db = makeMockDb()
      const change = makeChange('unknownEntityType', 'upsert', {})

      await expect(applyResolvedSyncChange(db, change)).rejects.toThrow(
        /Unhandled entityType 'unknownEntityType'/,
      )
    })
  })
})

// ---------------------------------------------------------------------------
// applyIncomingSyncChanges tests
// ---------------------------------------------------------------------------

describe('applyIncomingSyncChanges', () => {
  it('continues processing remaining changes after a per-entity failure (C2)', async () => {
    const db = makeMockDb({
      dish: {
        findFirst: vi.fn().mockResolvedValue(null),
        upsert: vi.fn()
          .mockRejectedValueOnce(new Error('DB error on first dish'))
          .mockResolvedValueOnce({}),
        deleteMany: vi.fn().mockResolvedValue({}),
      },
    })

    const changes: SyncChangeEnvelope[] = [
      makeChange('dish', 'upsert', {
        id: 'dish-fail',
        name: 'Fail Dish',
        userId: 'user-1',
        restaurantId: 'rest-1',
        branchId: 'branch-1',
        sellingPrice: 10,
      }),
      makeChange('dish', 'upsert', {
        id: 'dish-ok',
        name: 'OK Dish',
        userId: 'user-1',
        restaurantId: 'rest-1',
        branchId: 'branch-1',
        sellingPrice: 20,
      }),
    ]

    const result = await applyIncomingSyncChanges(db, changes, { localDeviceId: 'test-device' })

    expect(result.failedChanges).toHaveLength(1)
    expect(result.appliedChanges).toHaveLength(1)
    expect(result.failedChanges[0].error).toContain('DB error on first dish')
    expect(result.appliedChanges[0].payload).toMatchObject({ id: 'dish-ok' })
  })

  it('returns zero applied and zero failed when changes array is empty', async () => {
    const db = makeMockDb()
    const result = await applyIncomingSyncChanges(db, [], { localDeviceId: 'test-device' })

    expect(result.applied).toBe(0)
    expect(result.failedChanges).toHaveLength(0)
    expect(result.appliedChanges).toHaveLength(0)
  })

  // ── inventoryItem branch-scoped C1 ─────────────────────────────────────────

  it('inventoryItem C1: conflict query includes restaurantId and branchId so same-name items in different branches/restaurants are not merged', async () => {
    // When C1 fires, the findFirst where-clause must include both restaurantId and branchId.
    // Two items with the same name but different branches or different restaurants must
    // NOT trigger a merge (each restaurant+branch pair has its own namespace).
    const findFirst = vi.fn().mockResolvedValue(null) // no conflict in this scope
    const db = makeMockDb({
      inventoryItem: {
        findFirst,
        upsert: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({}),
      },
    })

    const change = makeChange('inventoryItem', 'upsert', {
      id: 'item-branch-b',
      name: 'Tomatoes',
      userId: 'user-1',
      restaurantId: 'rest-1',
      branchId: 'branch-B',
      unit: 'kg',
    }, { branchId: 'branch-B' })

    await applyResolvedSyncChange(db, change, { remapUserId: 'user-1' })

    // The conflict query must scope by restaurantId AND branchId, not just (userId, name)
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          restaurantId: 'rest-1',
          branchId: 'branch-B',
          name: 'Tomatoes',
        }),
      }),
    )
    // Upsert must use the incoming id (no conflict found)
    expect(db.inventoryItem.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'item-branch-b' } }),
    )
  })

  it('inventoryItem C1: records idRemap when incoming id is displaced to existing id', async () => {
    const db = makeMockDb({
      inventoryItem: {
        findFirst: vi.fn().mockResolvedValue({ id: 'existing-item-id' }),
        upsert: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({}),
      },
    })

    const idRemap = new Map<string, string>()
    const change = makeChange('inventoryItem', 'upsert', {
      id: 'incoming-item-id',
      name: 'Tomatoes',
      userId: 'user-1',
      restaurantId: 'rest-1',
      branchId: 'branch-1',
      unit: 'kg',
    })

    await applyResolvedSyncChange(db, change, { remapUserId: 'user-1', idRemap })

    // The remap must record: incoming id → existing (target) id
    expect(idRemap.get('incoming-item-id')).toBe('existing-item-id')
  })

  // ── FK remap: inventoryPurchase via applyIncomingSyncChanges ───────────────

  it('inventoryPurchase: ingredientId is remapped to the C1-displaced id within the same batch', async () => {
    const inventoryPurchaseUpsert = vi.fn().mockResolvedValue({})
    const db = makeMockDb({
      inventoryItem: {
        findFirst: vi.fn().mockResolvedValue({ id: 'existing-item-id' }),
        upsert: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({}),
      },
      inventoryPurchase: {
        upsert: inventoryPurchaseUpsert,
        deleteMany: vi.fn().mockResolvedValue({}),
      },
    })

    // Batch: inventoryItem first (will be C1-displaced), then inventoryPurchase
    const changes: SyncChangeEnvelope[] = [
      makeChange('inventoryItem', 'upsert', {
        id: 'incoming-item-id',
        name: 'Tomatoes',
        userId: 'user-1',
        restaurantId: 'rest-1',
        branchId: 'branch-1',
        unit: 'kg',
      }),
      makeChange('inventoryPurchase', 'upsert', {
        id: 'purchase-1',
        userId: 'user-1',
        restaurantId: 'rest-1',
        branchId: 'branch-1',
        // references the incoming id that was displaced by C1
        ingredientId: 'incoming-item-id',
        quantityPurchased: 10,
        remainingQuantity: 10,
        unitCost: 2,
        totalCost: 20,
      }),
    ]

    const result = await applyIncomingSyncChanges(db, changes, {
      localDeviceId: 'test-device',
      remapUserId: 'user-1',
    })

    // Both changes must succeed
    expect(result.failedChanges).toHaveLength(0)
    expect(result.applied).toBe(2)

    // The purchase upsert must use the resolved (existing) ingredient id
    const purchaseCall = inventoryPurchaseUpsert.mock.calls[0][0]
    expect(purchaseCall.update.ingredientId).toBe('existing-item-id')
    expect(purchaseCall.create.ingredientId).toBe('existing-item-id')
  })

  // ── FK remap: dishIngredient via applyIncomingSyncChanges ──────────────────

  it('dishIngredient: dishId is remapped to the C1-displaced id within the same batch', async () => {
    const dishIngredientUpsert = vi.fn().mockResolvedValue({})
    const db = makeMockDb({
      dish: {
        findFirst: vi.fn().mockResolvedValue({ id: 'existing-dish-id' }),
        upsert: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({}),
      },
      dishIngredient: {
        upsert: dishIngredientUpsert,
        deleteMany: vi.fn().mockResolvedValue({}),
      },
    })

    // Batch: dish first (C1-displaced), then dishIngredient referencing the incoming dish id
    const changes: SyncChangeEnvelope[] = [
      makeChange('dish', 'upsert', {
        id: 'incoming-dish-id',
        name: 'Jollof Rice',
        userId: 'user-1',
        restaurantId: 'rest-1',
        branchId: 'branch-1',
        sellingPrice: 25,
      }),
      makeChange('dishIngredient', 'upsert', {
        dishId: 'incoming-dish-id',   // displaced id — must be remapped
        inventoryItemId: 'ingredient-1',
        quantityRequired: 0.5,
      }),
    ]

    const result = await applyIncomingSyncChanges(db, changes, {
      localDeviceId: 'test-device',
      remapUserId: 'user-1',
    })

    expect(result.failedChanges).toHaveLength(0)
    expect(result.applied).toBe(2)

    // dishIngredient must resolve dishId to the existing (target) id
    const diCall = dishIngredientUpsert.mock.calls[0][0]
    expect(diCall.where.dishId_inventoryItemId.dishId).toBe('existing-dish-id')
    expect(diCall.create.dishId).toBe('existing-dish-id')
  })

  // ── FK remap: wasteLog via applyIncomingSyncChanges ────────────────────────

  it('wasteLog: ingredientId is remapped to the C1-displaced id within the same batch', async () => {
    const wasteLogUpsert = vi.fn().mockResolvedValue({})
    const db = makeMockDb({
      inventoryItem: {
        findFirst: vi.fn().mockResolvedValue({ id: 'existing-item-id' }),
        upsert: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({}),
      },
      wasteLog: {
        upsert: wasteLogUpsert,
        deleteMany: vi.fn().mockResolvedValue({}),
      },
    })

    // Batch: inventoryItem first (will be C1-displaced), then wasteLog referencing it
    const changes: SyncChangeEnvelope[] = [
      makeChange('inventoryItem', 'upsert', {
        id: 'incoming-item-id',
        name: 'Tomatoes',
        userId: 'user-1',
        restaurantId: 'rest-1',
        branchId: 'branch-1',
        unit: 'kg',
      }),
      makeChange('wasteLog', 'upsert', {
        id: 'waste-1',
        userId: 'user-1',
        restaurantId: 'rest-1',
        branchId: 'branch-1',
        ingredientId: 'incoming-item-id',   // displaced id — must be remapped
        quantityWasted: 2,
        reason: 'spoilage',
        date: new Date().toISOString(),
        calculatedCost: 4,
      }),
    ]

    const result = await applyIncomingSyncChanges(db, changes, {
      localDeviceId: 'test-device',
      remapUserId: 'user-1',
    })

    expect(result.failedChanges).toHaveLength(0)
    expect(result.applied).toBe(2)

    // wasteLog upsert must use the resolved (existing) ingredient id
    const wasteCall = wasteLogUpsert.mock.calls[0][0]
    expect(wasteCall.update.ingredientId).toBe('existing-item-id')
    expect(wasteCall.create.ingredientId).toBe('existing-item-id')
  })

  // ── FK remap: dishSale via applyIncomingSyncChanges ────────────────────────

  it('dishSale: dishId is remapped to the C1-displaced id within the same batch', async () => {
    const dishSaleUpsert = vi.fn().mockResolvedValue({})
    const db = makeMockDb({
      dish: {
        findFirst: vi.fn().mockResolvedValue({ id: 'existing-dish-id' }),
        upsert: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({}),
      },
      dishSale: {
        upsert: dishSaleUpsert,
        deleteMany: vi.fn().mockResolvedValue({}),
      },
    })

    // Batch: dish first (C1-displaced), then dishSale referencing the incoming dish id
    const changes: SyncChangeEnvelope[] = [
      makeChange('dish', 'upsert', {
        id: 'incoming-dish-id',
        name: 'Jollof Rice',
        userId: 'user-1',
        restaurantId: 'rest-1',
        branchId: 'branch-1',
        sellingPrice: 25,
      }),
      makeChange('dishSale', 'upsert', {
        id: 'sale-1',
        userId: 'user-1',
        restaurantId: 'rest-1',
        branchId: 'branch-1',
        dishId: 'incoming-dish-id',   // displaced id — must be remapped
        quantitySold: 3,
        saleDate: new Date().toISOString(),
        paymentMethod: 'Cash',
        totalSaleAmount: 75,
        calculatedFoodCost: 30,
      }),
    ]

    const result = await applyIncomingSyncChanges(db, changes, {
      localDeviceId: 'test-device',
      remapUserId: 'user-1',
    })

    expect(result.failedChanges).toHaveLength(0)
    expect(result.applied).toBe(2)

    // dishSale upsert must use the resolved (existing) dish id
    const saleCall = dishSaleUpsert.mock.calls[0][0]
    expect(saleCall.update.dishId).toBe('existing-dish-id')
    expect(saleCall.create.dishId).toBe('existing-dish-id')
  })
})
