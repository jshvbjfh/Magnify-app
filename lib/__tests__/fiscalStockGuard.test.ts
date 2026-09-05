/**
 * §7.30 — no receipt for goods when stock is short, services exempt.
 *
 * The exemption is the half that keeps a restaurant trading, so it is pinned
 * here as hard as the block itself.
 */

import { describe, expect, it } from 'vitest'

import {
  ITEM_TYPES,
  canIssueForStock,
  checkFiscalStock,
  describeStockRefusal,
  normalizeItemType,
} from '@/lib/fiscalStockGuard'

const { GOODS, SERVICE } = ITEM_TYPES

describe('goods are blocked when short', () => {
  it('refuses a line asking for more than is there', () => {
    const refusals = checkFiscalStock([
      { name: 'Mutzig 65cl', itemCode: 'RW-BEER-01', qty: 6, itemType: GOODS, available: 2 },
    ])

    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toMatchObject({ name: 'Mutzig 65cl', requested: 6, available: 2 })
  })

  it('allows a line with exactly enough', () => {
    expect(canIssueForStock([{ name: 'Mutzig', qty: 2, itemType: GOODS, available: 2 }])).toBe(true)
  })

  it('reports every short line, not just the first', () => {
    // A waiter told which items are short fixes the order once; told only that
    // "something" is short, they guess.
    const refusals = checkFiscalStock([
      { name: 'Mutzig', qty: 6, itemType: GOODS, available: 2 },
      { name: 'Fanta', qty: 3, itemType: GOODS, available: 10 },
      { name: 'Water', qty: 4, itemType: GOODS, available: 0 },
    ])

    expect(refusals.map((r) => r.name)).toEqual(['Mutzig', 'Water'])
  })
})

describe('services are exempt (§7.30)', () => {
  it('sells a service item with no stock at all', () => {
    expect(canIssueForStock([{ name: 'Grilled Tilapia', qty: 3, itemType: SERVICE, available: 0 }])).toBe(true)
  })

  it('treats an unmarked item as a service', () => {
    // The default. A restaurant sells mostly prepared food, and blocking those
    // would stop service over an incomplete recipe.
    for (const itemType of [null, undefined, '', 'anything else']) {
      expect(canIssueForStock([{ name: 'Dish', qty: 99, itemType, available: 0 }])).toBe(true)
    }
  })

  it('lets a mixed bill through on its service lines while blocking its goods', () => {
    const refusals = checkFiscalStock([
      { name: 'Grilled Tilapia', qty: 2, itemType: SERVICE, available: 0 },
      { name: 'Mutzig', qty: 6, itemType: GOODS, available: 1 },
    ])

    expect(refusals.map((r) => r.name)).toEqual(['Mutzig'])
  })
})

describe('unknown stock is not zero stock', () => {
  it('sells goods whose stock has never been counted', () => {
    // A venue midway through its first inventory must still be able to trade.
    // Reading "unknown" as "none" would stop it dead.
    expect(canIssueForStock([{ name: 'Mutzig', qty: 6, itemType: GOODS, available: null }])).toBe(true)
    expect(canIssueForStock([{ name: 'Mutzig', qty: 6, itemType: GOODS }])).toBe(true)
  })

  it('does block once a count exists and is short', () => {
    expect(canIssueForStock([{ name: 'Mutzig', qty: 6, itemType: GOODS, available: 0 }])).toBe(false)
  })

  it('ignores a quantity that is not a number rather than blocking service', () => {
    expect(canIssueForStock([{ name: 'Mutzig', qty: Number.NaN, itemType: GOODS, available: 1 }])).toBe(true)
  })
})

describe('normalizeItemType', () => {
  it('recognises GOODS in any casing', () => {
    expect(normalizeItemType('goods')).toBe(GOODS)
    expect(normalizeItemType(' GOODS ')).toBe(GOODS)
  })

  it('defaults everything else to SERVICE', () => {
    for (const value of [null, undefined, '', 'service', 'FOOD', 42]) {
      expect(normalizeItemType(value)).toBe(SERVICE)
    }
  })
})

describe('the message a waiter reads', () => {
  it('names the item and the shortfall', () => {
    const message = describeStockRefusal(
      checkFiscalStock([{ name: 'Mutzig 65cl', qty: 6, itemType: GOODS, available: 2 }]),
    )

    expect(message).toBe('Mutzig 65cl is short by 4 — only 2 left')
    expect(message).not.toContain('\n')
  })

  it('summarises when several are short', () => {
    const message = describeStockRefusal(
      checkFiscalStock([
        { name: 'Mutzig', qty: 6, itemType: GOODS, available: 1 },
        { name: 'Water', qty: 2, itemType: GOODS, available: 0 },
      ]),
    )

    expect(message).toBe('Mutzig and 1 more are out of stock')
  })

  it('says nothing when nothing is short', () => {
    expect(describeStockRefusal([])).toBeNull()
  })
})
