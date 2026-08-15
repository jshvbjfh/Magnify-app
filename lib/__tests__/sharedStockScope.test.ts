import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consumeIngredientStock, purchaseScopeWhere, recipeIngredientScopeWhere } from '@/lib/inventoryConsumption'

// Where consumption looks for stock is the whole risk of the shared-stock
// change: search the wrong place and a sale deducts nothing and books no cost,
// silently. These tests pin the lookup scope in both modes.

const db = vi.hoisted(() => ({
  inventoryItem: { findFirst: vi.fn(), update: vi.fn() },
  inventoryPurchase: { findMany: vi.fn(), update: vi.fn() },
  inventoryBatchUsageLedger: { create: vi.fn() },
  syncOutbox: { create: vi.fn() },
  restaurant: { findUnique: vi.fn() },
}))

vi.mock('@/lib/syncOutbox', () => ({
  enqueueSyncChange: vi.fn(),
  GLOBAL_SYNC_SCOPE_ID: 'global',
}))

const INGREDIENT = { id: 'ing-1', name: 'Tomatoes', unit: 'g', unitCost: 2, quantity: 5000 }

function baseParams(over: Record<string, unknown> = {}) {
  return {
    restaurantId: 'rest-1',
    branchId: 'branch-bar',
    ingredientId: 'ing-1',
    quantity: 100,
    fifoEnabled: true,
    sourceType: 'dishSale' as const,
    sourceId: 'sale-1',
    consumedAt: new Date('2026-08-12T10:00:00.000Z'),
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  db.inventoryItem.findFirst.mockResolvedValue(INGREDIENT)
  db.inventoryItem.update.mockResolvedValue({ ...INGREDIENT, branchId: 'branch-main', quantity: 4900 })
  db.inventoryPurchase.findMany.mockResolvedValue([
    { id: 'layer-1', batchId: 'B-1', branchId: 'branch-main', remainingQuantity: 500, unitCost: 2 },
  ])
  db.inventoryPurchase.update.mockResolvedValue({ id: 'layer-1', branchId: 'branch-main', remainingQuantity: 400 })
  db.inventoryBatchUsageLedger.create.mockImplementation(async ({ data }: any) => ({ id: 'ledger-1', ...data }))
})

describe('consumeIngredientStock scoping', () => {
  it('searches only the consuming station when shared stock is off', async () => {
    await consumeIngredientStock(db as never, baseParams())

    expect(db.inventoryItem.findFirst.mock.calls[0][0].where).toEqual({
      id: 'ing-1', restaurantId: 'rest-1', branchId: 'branch-bar',
    })
    expect(db.inventoryPurchase.findMany.mock.calls[0][0].where).toMatchObject({
      restaurantId: 'rest-1', branchId: 'branch-bar',
    })
  })

  it('searches the whole restaurant when shared stock is on', async () => {
    await consumeIngredientStock(db as never, baseParams({ sharedStock: true }))

    const itemWhere = db.inventoryItem.findFirst.mock.calls[0][0].where
    expect(itemWhere).toEqual({ id: 'ing-1', restaurantId: 'rest-1' })
    expect(itemWhere).not.toHaveProperty('branchId')

    const layerWhere = db.inventoryPurchase.findMany.mock.calls[0][0].where
    expect(layerWhere).not.toHaveProperty('branchId')
    expect(layerWhere).toMatchObject({ restaurantId: 'rest-1', ingredientId: 'ing-1' })
  })

  it('still records which station consumed it, not where the stock was held', async () => {
    // The whole point of keeping attribution: the pool is common, but "how much
    // did the bar get through" must still have an answer.
    await consumeIngredientStock(db as never, baseParams({ sharedStock: true }))

    expect(db.inventoryBatchUsageLedger.create.mock.calls[0][0].data).toMatchObject({
      branchId: 'branch-bar',
      ingredientId: 'ing-1',
    })
  })

  it('decrements stock relatively so two stations cannot lose each others writes', async () => {
    await consumeIngredientStock(db as never, baseParams({ sharedStock: true }))

    expect(db.inventoryItem.update.mock.calls[0][0].data.quantity).toEqual({ decrement: 100 })
  })
})

describe('recipeIngredientScopeWhere', () => {
  const scope = { restaurantId: 'rest-1', branchId: 'branch-bar' }

  it('keeps a station to its own stock when shared stock is off', () => {
    expect(recipeIngredientScopeWhere(scope)).toEqual({ restaurantId: 'rest-1', branchId: 'branch-bar' })
  })

  it('opens the whole restaurants raw stock to a station under shared stock', () => {
    // The bar builds recipes on ingredients held at the main station — without
    // this the picker is empty and every recipe save answers "Ingredient not found".
    expect(recipeIngredientScopeWhere({ ...scope, sharedStock: true })).toEqual({
      restaurantId: 'rest-1',
      OR: [{ type: { not: 'prep' } }, { branchId: 'branch-bar' }],
    })
  })

  it('leaves preps with the kitchen that made them', () => {
    // A sauce the lunch kitchen produced is not stock the bar can draw on, so
    // the prep half of the OR stays pinned to the asking station.
    const where = recipeIngredientScopeWhere({ ...scope, sharedStock: true }) as {
      OR: Array<Record<string, unknown>>
    }
    expect(where.OR).toContainEqual({ branchId: 'branch-bar' })
  })
})

describe('purchaseScopeWhere', () => {
  const scope = { restaurantId: 'rest-1', branchId: 'branch-bar' }

  it('keeps a station to its own batches when shared stock is off', () => {
    expect(purchaseScopeWhere(scope)).toEqual({ restaurantId: 'rest-1', branchId: 'branch-bar' })
  })

  it('shows a station the pools batches under shared stock', () => {
    // Without this the recipe card finds no FIFO layer behind an ingredient it
    // can plainly see in stock, and tags a fully-stocked line "Stock
    // insufficient — est. price".
    expect(purchaseScopeWhere({ ...scope, sharedStock: true })).toEqual({
      restaurantId: 'rest-1',
      OR: [{ ingredient: { type: { not: 'prep' } } }, { branchId: 'branch-bar' }],
    })
  })

  it('draws the same prep line as the ingredient scope', () => {
    // The two have to agree: a batch visible here whose ingredient is invisible
    // in the picker (or vice versa) is how the scopes drifted apart last time.
    const where = purchaseScopeWhere({ ...scope, sharedStock: true }) as {
      OR: Array<Record<string, unknown>>
    }
    expect(where.OR).toContainEqual({ branchId: 'branch-bar' })
  })
})
