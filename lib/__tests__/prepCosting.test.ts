/**
 * A prep's unitCost is a plain stored field — nothing computes it automatically,
 * so it silently sits at 0 (or a stale hand-typed number) forever unless
 * something recalculates it from the sub-recipe. This only covers that
 * recalculation; real sales already cost preps correctly via
 * consumePrepAwareIngredient, which cascades to raw ingredient FIFO consumption
 * and never reads this field.
 */

import { describe, it, expect, vi } from 'vitest'

import { recalculatePrepUnitCost } from '../prepCosting'

function makeDb(prepIngredientRows: Array<{ quantityRequired: number; ingredient: { unitCost: number | null } }>) {
  const update = vi.fn().mockResolvedValue({})
  const findMany = vi.fn().mockResolvedValue(prepIngredientRows)
  return {
    db: {
      prepIngredient: { findMany },
      inventoryItem: { update },
    } as any,
    findMany,
    update,
  }
}

describe('recalculatePrepUnitCost', () => {
  it('sums quantityRequired * ingredient unitCost across the sub-recipe', async () => {
    const { db, update } = makeDb([
      { quantityRequired: 40, ingredient: { unitCost: 1 } },   // 40g Tomatoes @ 1 RWF/g
    ])

    const cost = await recalculatePrepUnitCost(db, 'prep-1')

    expect(cost).toBe(40)
    expect(update).toHaveBeenCalledWith({ where: { id: 'prep-1' }, data: { unitCost: 40 } })
  })

  it('adds up multiple sub-recipe rows', async () => {
    const { db } = makeDb([
      { quantityRequired: 3, ingredient: { unitCost: 1000 } },   // Onions
      { quantityRequired: 0.15, ingredient: { unitCost: 2760 } }, // Vegetable oil
      { quantityRequired: 0.02, ingredient: { unitCost: 500 } },  // Salt
    ])

    const cost = await recalculatePrepUnitCost(db, 'prep-2')

    expect(cost).toBeCloseTo(3 * 1000 + 0.15 * 2760 + 0.02 * 500)
  })

  it('returns 0 for a prep with no sub-recipe yet, instead of throwing', async () => {
    const { db } = makeDb([])

    const cost = await recalculatePrepUnitCost(db, 'prep-empty')

    expect(cost).toBe(0)
  })

  it('treats a missing ingredient unitCost as 0 rather than producing NaN', async () => {
    const { db } = makeDb([
      { quantityRequired: 10, ingredient: { unitCost: null } },
    ])

    const cost = await recalculatePrepUnitCost(db, 'prep-3')

    expect(cost).toBe(0)
  })
})
