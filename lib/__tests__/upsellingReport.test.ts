import { describe, expect, it } from 'vitest'
import { buildUpsellingReport, classifyCategory, normalizeCategory, type UpsellCheck } from '@/lib/upsellingReport'

let seq = 0
function check(partial: Partial<UpsellCheck> & { items: UpsellCheck['items'] }): UpsellCheck {
  seq += 1
  return {
    orderId: `order-${seq}`,
    staffId: null,
    staffName: null,
    createdByName: 'Alice',
    totalAmount: 0,
    guestCount: null,
    ...partial,
  }
}

function line(category: string | null, dishPrice = 1000, qty = 1, dishName = category ?? 'Unknown') {
  return { dishId: `dish-${category ?? 'none'}`, dishName, category, qty, dishPrice }
}

describe('normalizeCategory', () => {
  // The live menu carries both spellings of several categories; the report must
  // not split one category into two.
  it('folds the plural drift in the live menu data', () => {
    expect(normalizeCategory('Grills')).toBe(normalizeCategory('Grill'))
    expect(normalizeCategory('Mocktails')).toBe(normalizeCategory('Mocktail'))
    expect(normalizeCategory('Pizzas')).toBe(normalizeCategory('Pizza'))
    expect(normalizeCategory('  DESSERTS ')).toBe('dessert')
  })

  it('leaves short and non-plural names alone', () => {
    expect(normalizeCategory('Pasta')).toBe('pasta')
    expect(normalizeCategory('Wok & Sizzling')).toBe('wok & sizzling')
    expect(normalizeCategory(null)).toBe('')
  })
})

describe('classifyCategory', () => {
  it('splits the menu into food, drinks and add-ons', () => {
    expect(classifyCategory('Burgers')).toBe('food')
    expect(classifyCategory('Wok & Sizzling')).toBe('food')
    expect(classifyCategory('Soft Drinks')).toBe('drink')
    expect(classifyCategory('Beers')).toBe('drink')
    expect(classifyCategory('Add-ons')).toBe('addon')
    expect(classifyCategory('Sides')).toBe('addon')
    expect(classifyCategory(null)).toBe('unknown')
  })
})

describe('buildUpsellingReport', () => {
  it('reports the share of a server\'s checks that carried an add-on', () => {
    const report = buildUpsellingReport([
      check({ totalAmount: 5000, items: [line('Burgers'), line('Add-ons')] }),
      check({ totalAmount: 4000, items: [line('Burgers')] }),
      check({ totalAmount: 4000, items: [line('Pizza')] }),
      check({ totalAmount: 6000, items: [line('Pizza'), line('Sides')] }),
    ])

    expect(report.rows).toHaveLength(1)
    expect(report.rows[0].checks).toBe(4)
    expect(report.rows[0].addonChecks).toBe(2)
    expect(report.rows[0].addonRate).toBe(50)
    expect(report.rows[0].avgCheck).toBe(4750)
  })

  // A guest who came in for two beers was not "upsold a drink" — that was the
  // visit. Counting bar-only checks in the denominator would drag every
  // server's drink rate down for sales they never had the chance to make.
  it('measures drink attachment against food checks only', () => {
    const report = buildUpsellingReport([
      check({ totalAmount: 5000, items: [line('Burgers'), line('Soft Drinks')] }),
      check({ totalAmount: 3000, items: [line('Burgers')] }),
      check({ totalAmount: 2000, items: [line('Beers'), line('Beers')] }),
    ])

    expect(report.rows[0].foodChecks).toBe(2)
    expect(report.rows[0].drinkAttachChecks).toBe(1)
    expect(report.rows[0].drinkAttachRate).toBe(50)
  })

  it('returns a null drink rate when a server took no food checks at all', () => {
    const report = buildUpsellingReport([
      check({ totalAmount: 2000, items: [line('Beers')] }),
    ])

    expect(report.rows[0].foodChecks).toBe(0)
    expect(report.rows[0].drinkAttachRate).toBeNull()
  })

  // The linked Staff row is the terminal screen's shared account, not the
  // person. Two waiters ringing up on one screen must not merge into one row.
  it('separates waiters who share a terminal account', () => {
    const report = buildUpsellingReport([
      check({ staffId: 'terminal-1', staffName: 'High 5ive waiter', createdByName: 'Kenny', totalAmount: 5000, items: [line('Burgers'), line('Add-ons')] }),
      check({ staffId: 'terminal-1', staffName: 'High 5ive waiter', createdByName: 'Mimi', totalAmount: 3000, items: [line('Burgers')] }),
    ])

    expect(report.rows).toHaveLength(2)
    expect(report.rows.map((r) => r.serverName).sort()).toEqual(['Kenny', 'Mimi'])
    expect(report.rows.every((r) => r.terminalAccount === 'High 5ive waiter')).toBe(true)
  })

  it('folds the same waiter typing their name in different cases', () => {
    const report = buildUpsellingReport([
      check({ staffName: 'High 5ive waiter', createdByName: 'kenny', totalAmount: 1000, items: [line('Burgers')] }),
      check({ staffName: 'High 5ive waiter', createdByName: 'Kenny', totalAmount: 3000, items: [line('Burgers'), line('Add-ons')] }),
    ])

    expect(report.rows).toHaveLength(1)
    expect(report.rows[0].checks).toBe(2)
    expect(report.rows[0].addonRate).toBe(50)
  })

  it('falls back to the terminal account when no waiter name was typed', () => {
    const report = buildUpsellingReport([
      check({ staffName: 'High 5ive waiter', createdByName: null, totalAmount: 1000, items: [line('Burgers')] }),
    ])

    expect(report.rows[0].serverName).toBe('High 5ive waiter')
  })

  it('ranks servers by attachment rate and still reports a house average', () => {
    const report = buildUpsellingReport([
      check({ createdByName: 'Weak', totalAmount: 1000, items: [line('Burgers')] }),
      check({ createdByName: 'Weak', totalAmount: 1000, items: [line('Burgers')] }),
      check({ createdByName: 'Strong', totalAmount: 2000, items: [line('Burgers'), line('Add-ons')] }),
    ])

    expect(report.rows.map((r) => r.serverName)).toEqual(['Strong', 'Weak'])
    expect(report.rows[0].addonRate).toBe(100)
    expect(report.rows[1].addonRate).toBe(0)
    // One of three checks across the whole house carried an add-on.
    expect(report.house.checks).toBe(3)
    expect(report.house.addonRate).toBe(33.3)
  })

  // Same rule as the dashboard APC: guest counts only started being recorded on
  // 2026-08-09, so revenue from uncounted orders must stay out of both sides.
  it('divides only guest-counted revenue by the guests on those same checks', () => {
    const report = buildUpsellingReport([
      check({ totalAmount: 12000, guestCount: 3, items: [line('Burgers')] }),
      check({ totalAmount: 8000, guestCount: 2, items: [line('Burgers')] }),
      check({ totalAmount: 50000, guestCount: null, items: [line('Burgers')] }),
    ])

    expect(report.rows[0].covers).toBe(5)
    expect(report.rows[0].coveredChecks).toBe(2)
    expect(report.rows[0].apc).toBe(4000)
    expect(report.meta.coveredChecks).toBe(2)
  })

  it('reports no APC at all when nothing has a guest count', () => {
    const report = buildUpsellingReport([
      check({ totalAmount: 9000, items: [line('Burgers')] }),
    ])

    expect(report.rows[0].apc).toBeNull()
    expect(report.meta.coveredChecks).toBe(0)
  })

  it('counts upsell revenue and its share of the bill', () => {
    const report = buildUpsellingReport([
      check({ totalAmount: 10000, items: [line('Burgers', 8000), line('Add-ons', 2000)] }),
    ])

    expect(report.rows[0].upsellRevenue).toBe(2000)
    expect(report.rows[0].upsellRevenueShare).toBe(20)
  })

  it('lists which add-ons and drinks actually get attached', () => {
    const report = buildUpsellingReport([
      check({ totalAmount: 5000, items: [line('Burgers'), line('Sides', 1000, 2)] }),
      check({ totalAmount: 4000, items: [line('Burgers'), line('Sides')] }),
      check({ totalAmount: 4000, items: [line('Burgers'), line('Soft Drinks')] }),
    ])

    expect(report.attachedItems[0].dishName).toBe('Sides')
    expect(report.attachedItems[0].qty).toBe(3)
    expect(report.attachedItems[0].checks).toBe(2)
    // Food never shows up as an attachable item.
    expect(report.attachedItems.some((i) => i.dishName === 'Burgers')).toBe(false)
  })

  // QR self-orders have no server to credit or blame. Left in, they showed up
  // in the live data as a dozen "Guest - …" rows scoring 0% attach.
  it('keeps guest QR self-orders out of the server ranking', () => {
    const report = buildUpsellingReport([
      check({ createdByName: 'Alice', totalAmount: 5000, items: [line('Burgers'), line('Add-ons')] }),
      check({ createdByName: 'Guest QR Order', totalAmount: 3000, items: [line('Burgers')] }),
      check({ createdByName: 'Guest - Kyle', totalAmount: 2000, items: [line('Burgers')] }),
    ])

    expect(report.rows).toHaveLength(1)
    expect(report.rows[0].serverName).toBe('Alice')
    expect(report.meta.selfOrderChecks).toBe(2)
    expect(report.meta.serverChecks).toBe(1)
    // The house must not be diluted by bills nobody served.
    expect(report.house.checks).toBe(1)
    expect(report.house.addonRate).toBe(100)
  })

  // Confirming a QR order sends it to the kitchen; it does not mean the waiter
  // sold anything. The guest had already picked the items.
  it('still excludes a QR order after a waiter confirms it', () => {
    const report = buildUpsellingReport([
      check({ staffName: 'High 5ive waiter', createdByName: 'Guest - Kyle · confirmed by Mimi', totalAmount: 5000, items: [line('Burgers')] }),
    ])

    expect(report.meta.selfOrderChecks).toBe(1)
    expect(report.rows).toHaveLength(0)
  })

  // Bills carrying a total but no line items exist in the history; nothing can
  // be attached to an empty bill, so they must not read as a failed upsell.
  it('excludes itemless bills from the add-on denominator', () => {
    const report = buildUpsellingReport([
      check({ totalAmount: 5000, items: [line('Burgers'), line('Add-ons')] }),
      check({ totalAmount: 4000, items: [] }),
      check({ totalAmount: 4000, items: [] }),
    ])

    expect(report.rows[0].checks).toBe(3)
    expect(report.rows[0].checksWithItems).toBe(1)
    expect(report.rows[0].addonRate).toBe(100)
  })

  it('reports no add-on rate at all when no bill had a single item', () => {
    const report = buildUpsellingReport([
      check({ totalAmount: 4000, items: [] }),
    ])

    expect(report.rows[0].addonRate).toBeNull()
  })

  it('flags checks with no server and items with no category', () => {
    const report = buildUpsellingReport([
      check({ createdByName: null, totalAmount: 1000, items: [line(null)] }),
    ])

    expect(report.meta.checksWithoutServer).toBe(1)
    expect(report.meta.uncategorizedItems).toBe(1)
    expect(report.rows[0].serverName).toBe('Unattributed')
  })
})
