import { describe, expect, it } from 'vitest'
import { buildUpsellingReport, classifyCategory, confidenceFor, normalizeCategory, type UpsellCheck } from '@/lib/upsellingReport'

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
  return { dishId: `dish-${category ?? 'none'}`, dishName, category, qty, dishPrice, foodCost: null }
}

/** A named dish, so pairings can be asserted on identity rather than category. */
function dish(id: string, category: string, dishPrice = 1000, foodCost: number | null = null, qty = 1) {
  return { dishId: id, dishName: id, category, qty, dishPrice, foodCost }
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

  it('ranks servers by upsell profit per bill and still reports a house average', () => {
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

  it('ranks a waiter with volume above one without, whatever their rate', () => {
    // 25 bills of a steady seller vs 2 bills of someone who attached on both.
    const many = Array.from({ length: 25 }, () =>
      check({ createdByName: 'Steady', totalAmount: 5000, items: [line('Burgers'), line('Add-ons')] }))
    const few = Array.from({ length: 2 }, () =>
      check({ createdByName: 'Newbie', totalAmount: 9000, items: [line('Burgers'), line('Add-ons', 5000)] }))

    const report = buildUpsellingReport([...many, ...few])
    expect(report.rows[0].serverName).toBe('Steady')
    expect(report.rows[0].ranked).toBe(true)
    expect(report.rows[1].serverName).toBe('Newbie')
    expect(report.rows[1].ranked).toBe(false)
    expect(report.rows[1].vsHouse).toBeNull()
  })

  // Live data carries a waiter with 22 bills that have no line items at all.
  // Counting those toward the volume floor ranked a data artifact against the
  // house and printed a confident deficit next to it.
  it('does not rank a waiter whose bills carry no line items', () => {
    const report = buildUpsellingReport(
      Array.from({ length: 25 }, () => check({ createdByName: 'Empty', totalAmount: 4000, items: [] }))
    )

    expect(report.rows[0].checks).toBe(25)
    expect(report.rows[0].checksWithItems).toBe(0)
    expect(report.rows[0].ranked).toBe(false)
    expect(report.rows[0].vsHouse).toBeNull()
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

/** n bills of Burger, the first `withSoda` of which also carry a Soda. */
function burgerBills(n: number, withSoda: number, waiter = 'Alice', sodaCost: number | null = null) {
  return Array.from({ length: n }, (_, i) =>
    check({
      createdByName: waiter,
      totalAmount: 5000,
      items: i < withSoda
        ? [dish('Burger', 'Burgers', 4000), dish('Soda', 'Soft Drinks', 1000, sodaCost)]
        : [dish('Burger', 'Burgers', 4000)],
    }))
}

describe('buildUpsellingReport — pairings', () => {
  it('counts attachment per bill and prices the pairing on FIFO food cost', () => {
    const report = buildUpsellingReport(burgerBills(10, 5, 'Alice', 200))

    expect(report.pairings).toHaveLength(1)
    const pair = report.pairings[0]
    expect(pair.baseName).toBe('Burger')
    expect(pair.attachName).toBe('Soda')
    expect(pair.baseBills).toBe(10)
    expect(pair.together).toBe(5)
    expect(pair.attachRate).toBe(50)
    expect(pair.revenue).toBe(5000)
    expect(pair.cost).toBe(1000)
    expect(pair.profit).toBe(4000)
    expect(pair.margin).toBe(80)
  })

  // Ordering two burgers is still one chance to attach a soda, not two.
  it('counts a dish ordered twice on one bill as a single opportunity', () => {
    const report = buildUpsellingReport([
      ...burgerBills(9, 4),
      check({
        createdByName: 'Alice',
        totalAmount: 9000,
        items: [dish('Burger', 'Burgers', 4000, null, 2), dish('Soda', 'Soft Drinks', 1000)],
      }),
    ])

    const pair = report.pairings.find((p) => p.attachName === 'Soda')
    expect(pair?.baseBills).toBe(10)
    expect(pair?.together).toBe(5)
  })

  it('hides pairings that are too rare to mean anything', () => {
    // Base seen 10 times but attached only twice — below the floor of 4.
    const report = buildUpsellingReport(burgerBills(10, 2))
    expect(report.pairings).toHaveLength(0)
    // Still counted so the UI can say how many exist.
    expect(report.meta.pairingsTotal).toBe(0)
  })

  it('grades confidence by how many bills the rate rests on', () => {
    expect(confidenceFor(250)).toBe('high')
    expect(confidenceFor(100)).toBe('high')
    expect(confidenceFor(99)).toBe('medium')
    expect(confidenceFor(15)).toBe('medium')
    expect(confidenceFor(8)).toBe('low')
  })

  it('marks a thin pairing as low confidence even when its rate looks strong', () => {
    const report = buildUpsellingReport(burgerBills(8, 4))
    expect(report.pairings[0].attachRate).toBe(50)
    expect(report.pairings[0].confidence).toBe('low')
  })
})

describe('buildUpsellingReport — opportunity', () => {
  it('benchmarks against the best waiter on that pairing and prices the gap in profit', () => {
    // Alice attaches on 2 of 10; Bob on 5 of 5. House is 7 of 15.
    const report = buildUpsellingReport([
      ...burgerBills(10, 2, 'Alice', 200),
      ...burgerBills(5, 5, 'Bob', 200),
    ])

    const pair = report.pairings[0]
    expect(pair.baseBills).toBe(15)
    expect(pair.together).toBe(7)

    const opp = report.opportunities[0]
    expect(opp.bestServerName).toBe('Bob')
    expect(opp.bestServerRate).toBe(100)
    expect(opp.houseRate).toBe(46.7)
    expect(opp.gapPoints).toBe(53.3)
    // 53.3% of 15 bills at 800 profit each.
    expect(opp.missedProfit).toBe(Math.round((53.3 / 100) * 15 * 800))
  })

  it('ignores a waiter who has not served the base dish often enough to benchmark', () => {
    // Bob attaches on both his bills, but 2 is under the 5-bill floor.
    const report = buildUpsellingReport([
      ...burgerBills(10, 4, 'Alice'),
      ...burgerBills(2, 2, 'Bob'),
    ])

    // Alice is the only eligible benchmark and she is the house, so no gap.
    expect(report.opportunities).toHaveLength(0)
  })

  // Summing every overlapping pairing would promise a prize nobody could collect.
  it('limits the headline opportunity to the pairings actually shown', () => {
    const report = buildUpsellingReport([
      ...burgerBills(10, 2, 'Alice', 200),
      ...burgerBills(5, 5, 'Bob', 200),
    ])

    const shown = report.opportunities.slice(0, 3).reduce((s, o) => s + o.missedProfit, 0)
    expect(report.summary.opportunity).toBe(shown)
  })

  it('summarises profit, margin and profit per bill for the house', () => {
    const report = buildUpsellingReport(burgerBills(10, 5, 'Alice', 200))

    expect(report.summary.bills).toBe(10)
    expect(report.summary.upsellRevenue).toBe(5000)
    expect(report.summary.upsellProfit).toBe(4000)
    expect(report.summary.upsellMargin).toBe(80)
    expect(report.summary.profitPerBill).toBe(400)
  })

  // The headline sentence names a leader only when someone has earned the
  // label; on ten bills nobody has, and it says nothing rather than guessing.
  it('names no leader until a waiter clears the volume floor', () => {
    const thin = buildUpsellingReport(burgerBills(10, 5, 'Alice', 200))
    expect(thin.summary.topServerName).toBeNull()

    // The headline rate is the add-on rate, so the bills must carry add-ons —
    // a soda would leave it at 0 however often it was attached.
    const solid = buildUpsellingReport(
      Array.from({ length: 22 }, (_, i) => check({
        createdByName: 'Alice',
        totalAmount: 5000,
        items: i < 11
          ? [dish('Burger', 'Burgers', 4000), dish('Fries', 'Sides', 1000, 200)]
          : [dish('Burger', 'Burgers', 4000)],
      }))
    )
    expect(solid.summary.topServerName).toBe('Alice')
    expect(solid.summary.topServerRate).toBe(50)
  })

  it('counts attached lines that were never costed instead of calling them pure profit', () => {
    const report = buildUpsellingReport(burgerBills(10, 5, 'Alice', null))
    expect(report.meta.uncostedAttachLines).toBe(5)
  })
})
