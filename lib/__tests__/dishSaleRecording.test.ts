/**
 * Unit tests for recordDishSalesForPaidOrder's station attribution — proves the
 * OrderItem.branchId snapshot fix: a dish reassigned to a different station
 * while an order sat open/unpaid must not retroactively change where its sale
 * gets booked. The snapshot taken when the item was rung up wins over the
 * dish's current branchId.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../syncOutbox', () => ({
  enqueueSyncChange: vi.fn().mockResolvedValue(undefined),
}))

import { recordDishSalesForPaidOrder } from '../dishSaleRecording'

const REST = 'rest-1'

/** Dish has no ingredients and no MEP portions — isolates the test to branch attribution. */
function makeDb(dish: { id: string; branchId: string; name: string }) {
  const dishSaleCreate = vi.fn().mockResolvedValue({ id: 'sale-1' })
  const dishSaleUpdate = vi.fn().mockResolvedValue({ id: 'sale-1' })
  return {
    db: {
      dish: {
        findMany: vi.fn().mockResolvedValue([{ ...dish, ingredients: [] }]),
        findUnique: vi.fn().mockResolvedValue({ preparedPortions: 0, preparedPortionCost: 0 }),
      },
      dishSale: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: dishSaleCreate,
        update: dishSaleUpdate,
      },
      dishSaleIngredient: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    } as any,
    dishSaleCreate,
  }
}

describe('recordDishSalesForPaidOrder — station attribution', () => {
  it('uses the item.branchId snapshot, not the dish\'s current (reassigned) branchId', async () => {
    const { db, dishSaleCreate } = makeDb({ id: 'dish-A', branchId: 'kitchen-new', name: 'Amstel' })

    await recordDishSalesForPaidOrder(db, {
      restaurantId: REST,
      branchId: 'till-branch',
      orderId: 'ord-1',
      saleDate: new Date('2026-07-21T12:00:00Z'),
      items: [{
        orderItemId: 'it-1',
        dishId: 'dish-A',
        dishPrice: 3000,
        qty: 1,
        // Snapshotted as parking-bar when the item was rung up; the dish has
        // since been reassigned to kitchen-new (e.g. via an admin/ad-hoc move).
        branchId: 'parking-bar-snapshot',
      }],
    })

    expect(dishSaleCreate).toHaveBeenCalledTimes(1)
    const created = dishSaleCreate.mock.calls[0][0].data
    expect(created.branchId).toBe('parking-bar-snapshot')
  })

  it('falls back to the dish\'s current branchId when the item carries no snapshot (legacy rows)', async () => {
    const { db, dishSaleCreate } = makeDb({ id: 'dish-A', branchId: 'kitchen-new', name: 'Amstel' })

    await recordDishSalesForPaidOrder(db, {
      restaurantId: REST,
      branchId: 'till-branch',
      orderId: 'ord-1',
      saleDate: new Date('2026-07-21T12:00:00Z'),
      items: [{
        orderItemId: 'it-1',
        dishId: 'dish-A',
        dishPrice: 3000,
        qty: 1,
        // No branchId snapshot — pre-migration order item.
      }],
    })

    const created = dishSaleCreate.mock.calls[0][0].data
    expect(created.branchId).toBe('kitchen-new')
  })
})
