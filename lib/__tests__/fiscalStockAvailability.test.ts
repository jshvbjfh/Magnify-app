import { describe, it, expect } from 'vitest'
import { availabilityByDish, dishAvailability } from '@/lib/fiscalStockAvailability'
import { canIssueForStock } from '@/lib/fiscalStockGuard'

const onHand = (entries: Array<[string, number]>) => new Map(entries)

describe('dishAvailability', () => {
  it('is limited by the scarcest ingredient', () => {
    const available = dishAvailability({
      itemType: 'GOODS',
      recipe: [
        { inventoryItemId: 'beer', quantityRequired: 1 },
        { inventoryItemId: 'crate', quantityRequired: 0.05 },
      ],
      onHand: onHand([['beer', 7], ['crate', 100]]),
    })
    expect(available).toBe(7)
  })

  it('counts whole portions only', () => {
    // Two thirds of the flour for a third pizza is not a third pizza.
    const available = dishAvailability({
      itemType: 'GOODS',
      recipe: [{ inventoryItemId: 'flour', quantityRequired: 0.3 }],
      onHand: onHand([['flour', 0.8]]),
    })
    expect(available).toBe(2)
  })

  it('is unknown, not zero, when nothing links the dish to stock', () => {
    // The distinction the guard depends on: a venue part-way through building
    // its recipes must not have every dish refused.
    const available = dishAvailability({ itemType: 'GOODS', recipe: [], onHand: onHand([]) })
    expect(available).toBeUndefined()
    expect(canIssueForStock([{ name: 'Tilapia', qty: 3, itemType: 'GOODS', available }])).toBe(true)
  })

  it('is zero, and blocking, when the recipe is known and the store is empty', () => {
    const available = dishAvailability({
      itemType: 'GOODS',
      recipe: [{ inventoryItemId: 'beer', quantityRequired: 1 }],
      onHand: onHand([['beer', 0]]),
    })
    expect(available).toBe(0)
    expect(canIssueForStock([{ name: 'Mutzig', qty: 1, itemType: 'GOODS', available }])).toBe(false)
  })

  it('treats a missing ingredient row as empty, not as unknown', () => {
    // The recipe names an item the store has no row for. That is a real zero:
    // the link exists, the stock does not.
    const available = dishAvailability({
      itemType: 'GOODS',
      recipe: [{ inventoryItemId: 'gone', quantityRequired: 1 }],
      onHand: onHand([]),
    })
    expect(available).toBe(0)
  })

  it('adds prepared portions to what the raw stock supports', () => {
    // MEP portions are already cooked — their ingredients have left the store,
    // so they are additional to whatever the remaining stock can still make.
    const available = dishAvailability({
      itemType: 'SERVICE',
      preparedPortions: 4,
      recipe: [{ inventoryItemId: 'fish', quantityRequired: 1 }],
      onHand: onHand([['fish', 3]]),
    })
    expect(available).toBe(7)
  })

  it('reports prepared portions even with no recipe', () => {
    expect(dishAvailability({ preparedPortions: 5, recipe: [], onHand: onHand([]) })).toBe(5)
  })

  it('ignores a recipe line asking for nothing', () => {
    // A zero quantityRequired would divide to Infinity and mask a real shortage.
    const available = dishAvailability({
      itemType: 'GOODS',
      recipe: [
        { inventoryItemId: 'beer', quantityRequired: 1 },
        { inventoryItemId: 'garnish', quantityRequired: 0 },
      ],
      onHand: onHand([['beer', 2], ['garnish', 0]]),
    })
    expect(available).toBe(2)
  })
})

describe('availabilityByDish', () => {
  it('answers for every dish from one set of quantities', () => {
    const result = availabilityByDish(
      [
        { id: 'd1', itemType: 'GOODS' },
        { id: 'd2', itemType: 'GOODS' },
        { id: 'd3', itemType: 'SERVICE' },
      ],
      new Map([
        ['d1', [{ inventoryItemId: 'beer', quantityRequired: 1 }]],
        ['d2', [{ inventoryItemId: 'beer', quantityRequired: 2 }]],
      ]),
      onHand([['beer', 5]]),
    )

    expect(result.get('d1')).toBe(5)
    expect(result.get('d2')).toBe(2)
    // No recipe — unknown, so it will not be blocked.
    expect(result.get('d3')).toBeUndefined()
  })
})
