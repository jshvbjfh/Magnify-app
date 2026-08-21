import { describe, expect, it } from 'vitest'
import {
  affinityFor,
  buildPairingExplorer,
  buildUpsellingReport,
  classifyCategory,
  classifyItem,
  liftFor,
  type UpsellCheck,
} from '@/lib/upsellingReport'

/** An instant at the given clock hour AT THE RESTAURANT (UTC+2). */
function atHour(hour: number, day = '2026-08-01'): Date {
  return new Date(`${day}T${String(hour).padStart(2, '0')}:30:00.000+02:00`)
}

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
    orderedAt: atHour(12),
    ...partial,
  }
}

function dish(
  id: string,
  category: string,
  dishPrice = 1000,
  foodCost: number | null = null,
  qty = 1,
  menuType: string | null = null,
) {
  return { dishId: id, dishName: id, category, menuType, qty, dishPrice, foodCost }
}

/** n bills, each built by `make`. */
function bills(n: number, make: (i: number) => UpsellCheck['items']) {
  return Array.from({ length: n }, (_, i) => check({ items: make(i) }))
}

// ─── CLASSIFICATION VIA menuType ───────────────────────────────────────────

describe('classifyItem', () => {
  // The word list only knows categories someone thought to put in it. Sirocco Y
  // Sol files 43 of its 62 drinks under names it has never heard of, and the
  // category-only classifier calls every one of them food — which breaks the
  // drink-attach rate in both directions at once.
  it('reads menuType when the category word is not recognised', () => {
    for (const category of [
      'Iced coffee', 'Tea&specialty', 'Red wine', 'white whine',
      'Fresh juices', 'Sparkling wines', 'specialty brews', 'Rose wine',
    ]) {
      expect(classifyCategory(category)).toBe('food') // the old behaviour
      expect(classifyItem({ category, menuType: 'drinks' })).toBe('drink')
    }
  })

  it('lets a recognised category word win over menuType', () => {
    // "Sides" is an add-on even though its menuType is also "sides", and an
    // add-on filed under "mains" is still an add-on.
    expect(classifyItem({ category: 'Sides', menuType: 'sides' })).toBe('addon')
    expect(classifyItem({ category: 'Add-ons', menuType: 'mains' })).toBe('addon')
    expect(classifyItem({ category: 'Beers', menuType: 'mains' })).toBe('drink')
  })

  it('maps the remaining menuType values', () => {
    expect(classifyItem({ category: 'Mains Dish', menuType: 'mains' })).toBe('food')
    expect(classifyItem({ category: 'Extras', menuType: 'sides' })).toBe('addon')
  })

  it('falls back to food for an unknown category with no usable menuType', () => {
    expect(classifyItem({ category: 'Shisha', menuType: null })).toBe('food')
    expect(classifyItem({ category: 'Shisha', menuType: 'nonsense' })).toBe('food')
  })

  it('is unknown only when there is no category at all', () => {
    expect(classifyItem({ category: null, menuType: null })).toBe('unknown')
    expect(classifyItem({ category: '   ', menuType: null })).toBe('unknown')
    // A blank category with a real menuType is still classifiable.
    expect(classifyItem({ category: null, menuType: 'drinks' })).toBe('drink')
  })

  it('agrees with classifyCategory whenever the word is recognised', () => {
    for (const category of ['Beers', 'Sides', 'Mocktails', 'Desserts', 'Burgers']) {
      expect(classifyItem({ category })).toBe(classifyCategory(category))
    }
  })

  it('changes the drink-attach rate for a Sirocco-shaped menu', () => {
    // Six bills, each a main plus a glass of wine filed as "Red wine".
    const checks = bills(6, () => [
      dish('lamb', 'Mains dish', 12000, 5000, 1, 'mains'),
      dish('merlot', 'Red wine', 8000, 3000, 1, 'drinks'),
    ])
    const report = buildUpsellingReport(checks)
    // Every bill has a food item and a drink attached to it.
    expect(report.house.foodChecks).toBe(6)
    expect(report.house.drinkAttachChecks).toBe(6)
    expect(report.house.drinkAttachRate).toBe(100)
  })
})

// ─── LIFT ──────────────────────────────────────────────────────────────────

describe('liftFor', () => {
  it('is 1 when the two are independent', () => {
    // 100 bills, base on 50, attach on 20, together on the 10 chance predicts.
    expect(liftFor(10, 50, 20, 100)).toBeCloseTo(1)
  })

  it('rises above 1 for a genuine affinity', () => {
    expect(liftFor(20, 50, 20, 100)).toBeCloseTo(2)
  })

  it('drops below 1 when the two substitute for each other', () => {
    expect(liftFor(5, 50, 20, 100)).toBeCloseTo(0.5)
  })

  it('is null when either side never sold', () => {
    expect(liftFor(0, 0, 20, 100)).toBeNull()
    expect(liftFor(0, 50, 0, 100)).toBeNull()
    expect(liftFor(0, 50, 20, 0)).toBeNull()
  })

  it('catches the live artifact this metric exists for', () => {
    // High 5ive's #1 opportunity, "Signature Dumplings + SODA": 22 dumpling
    // bills, 4 together, SODA on 56 of 126 bills. It tops the list on attach
    // rate alone, but guests take a soda with dumplings LESS often than chance.
    const lift = liftFor(4, 22, 56, 126) as number
    expect(lift).toBeLessThan(1)
    expect(affinityFor(Math.round(lift * 10) / 10)).toBe('substitutes')
  })
})

describe('affinityFor', () => {
  it('bands lift the way the copy describes it', () => {
    expect(affinityFor(3.4)).toBe('real')
    expect(affinityFor(2)).toBe('real')
    expect(affinityFor(1.5)).toBe('mild')
    expect(affinityFor(1)).toBe('coincidence')
    expect(affinityFor(0.6)).toBe('substitutes')
    expect(affinityFor(null)).toBe('unknown')
  })
})

describe('lift on the report pairings', () => {
  it('separates a real pairing from a merely popular attach', () => {
    // Steak always takes wine. Soda is on everything, steak or not.
    const steakAndWine = bills(10, () => [
      dish('steak', 'Mains', 10000, 4000),
      dish('wine', 'Red wine', 8000, 2000, 1, 'drinks'),
      dish('soda', 'Soft Drinks', 1000, 200),
    ])
    const sodaEverywhere = bills(30, () => [
      dish('salad', 'Mains', 5000, 2000),
      dish('soda', 'Soft Drinks', 1000, 200),
    ])
    const report = buildUpsellingReport([...steakAndWine, ...sodaEverywhere])

    const wine = report.pairings.find((p) => p.baseDishId === 'steak' && p.attachDishId === 'wine')
    const soda = report.pairings.find((p) => p.baseDishId === 'steak' && p.attachDishId === 'soda')

    // Both attach to every steak bill, so attach rate cannot tell them apart.
    expect(wine?.attachRate).toBe(100)
    expect(soda?.attachRate).toBe(100)
    // Lift can: wine only ever appears with steak; soda appears with anything.
    expect(wine?.lift).toBeGreaterThan(2)
    expect(soda?.lift).toBeCloseTo(1, 1)
  })

  it('counts attach bills once even when a dish is rung twice on one bill', () => {
    // Ten bills, so the pairing clears PAIRING_MIN_BASE_BILLS and is published.
    const checks = bills(10, () => [
      dish('steak', 'Mains'),
      dish('soda', 'Soft Drinks'),
      dish('soda', 'Soft Drinks'),
    ])
    const report = buildUpsellingReport(checks)
    const soda = report.attachedItems.find((a) => a.dishId === 'soda')
    // Ten bills carried a soda, not twenty lines' worth of bills.
    expect(soda?.checks).toBe(10)
    expect(soda?.qty).toBe(20)
    const pairing = report.pairings.find((p) => p.attachDishId === 'soda')
    expect(pairing?.attachBills).toBe(10)
    // Every bill has both, so together == base == attach == bills: lift is 1.
    expect(pairing?.lift).toBeCloseTo(1)
  })
})

// ─── PAIRING EXPLORER ──────────────────────────────────────────────────────

describe('buildPairingExplorer', () => {
  it('answers what pairs with a dish, ranked by gross profit', () => {
    const checks = bills(6, () => [
      dish('steak', 'Mains', 10000, 4000),
      dish('wine', 'Red wine', 8000, 2000, 1, 'drinks'),
      dish('fries', 'Sides', 2000, 500),
    ])
    const out = buildPairingExplorer(checks, { kind: 'dish', dishId: 'steak' })

    expect(out.subjectBills).toBe(6)
    expect(out.rows.map((r) => r.dishId)).toEqual(['wine', 'fries'])
    expect(out.rows[0].profit).toBe(36000) // 6 x (8000 - 2000)
    expect(out.rows[0].pairRate).toBe(100)
  })

  it('answers across menus, not just add-ons and drinks', () => {
    // A starter that pulls a main is a real finding; the pairings table would
    // never show it because a main is not an "attach".
    const checks = bills(5, () => [
      dish('mezze', 'Starters', 4000, 1000),
      dish('lamb', 'Mains', 12000, 5000),
    ])
    const out = buildPairingExplorer(checks, { kind: 'dish', dishId: 'mezze' })
    expect(out.rows.map((r) => r.dishId)).toEqual(['lamb'])
    expect(out.rows[0].group).toBe('food')
  })

  it('never pairs the subject with itself', () => {
    const checks = bills(5, () => [dish('steak', 'Mains'), dish('wine', 'Red wine')])
    const out = buildPairingExplorer(checks, { kind: 'dish', dishId: 'steak' })
    expect(out.rows.some((r) => r.dishId === 'steak')).toBe(false)
  })

  it('excludes every dish in the category when the subject is a category', () => {
    // Asking what goes with Burgers must not answer "another burger".
    const checks = bills(5, () => [
      dish('smash', 'Burgers'),
      dish('signature', 'Burgers'),
      dish('coke', 'Soft Drinks'),
    ])
    const out = buildPairingExplorer(checks, { kind: 'category', category: 'Burgers' })
    expect(out.subjectBills).toBe(5)
    expect(out.rows.map((r) => r.dishId)).toEqual(['coke'])
  })

  it('matches a category subject through the same plural folding as the report', () => {
    const checks = bills(4, () => [dish('grill-plate', 'Grills'), dish('coke', 'Soft Drinks')])
    const out = buildPairingExplorer(checks, { kind: 'category', category: 'Grill' })
    expect(out.subjectBills).toBe(4)
    expect(out.rows.map((r) => r.dishId)).toEqual(['coke'])
  })

  it('counts a dish rung twice on one bill as one bill', () => {
    const checks = bills(4, () => [
      dish('steak', 'Mains'),
      dish('coke', 'Soft Drinks'),
      dish('coke', 'Soft Drinks'),
    ])
    const out = buildPairingExplorer(checks, { kind: 'dish', dishId: 'steak' })
    const coke = out.rows.find((r) => r.dishId === 'coke')
    expect(coke?.together).toBe(4)
    expect(coke?.pairRate).toBe(100)
    expect(coke?.qty).toBe(8) // quantity still counts both lines
  })

  it('hides pairings under the floor but counts them', () => {
    const checks = [
      ...bills(5, () => [dish('steak', 'Mains'), dish('wine', 'Red wine')]),
      check({ items: [dish('steak', 'Mains'), dish('olives', 'Sides')] }),
    ]
    const out = buildPairingExplorer(checks, { kind: 'dish', dishId: 'steak' })
    expect(out.rows.map((r) => r.dishId)).toEqual(['wine'])
    expect(out.meta.belowFloor).toBe(1)
  })

  it('marks a ubiquitous item as coincidence even at a perfect pair rate', () => {
    const withSteak = bills(6, () => [dish('steak', 'Mains'), dish('water', 'Water', 500, 100)])
    const withoutSteak = bills(30, () => [dish('salad', 'Mains'), dish('water', 'Water', 500, 100)])
    const out = buildPairingExplorer([...withSteak, ...withoutSteak], { kind: 'dish', dishId: 'steak' })

    const water = out.rows.find((r) => r.dishId === 'water')
    expect(water?.pairRate).toBe(100)   // looks perfect
    expect(water?.lift).toBeCloseTo(1)  // and means nothing
    expect(water?.affinity).toBe('coincidence')
  })

  it('respects the service window', () => {
    const checks = [
      ...bills(4, () => [dish('steak', 'Mains'), dish('wine', 'Red wine')])
        .map((c) => ({ ...c, orderedAt: atHour(20) })),
      ...bills(4, () => [dish('steak', 'Mains'), dish('coffee', 'Hot Drinks')])
        .map((c) => ({ ...c, orderedAt: atHour(9) })),
    ]
    const out = buildPairingExplorer(checks, { kind: 'dish', dishId: 'steak' }, { hourFrom: 18, hourTo: 22 })
    expect(out.bills).toBe(4)
    expect(out.rows.map((r) => r.dishId)).toEqual(['wine'])
  })

  it('keeps guest QR bills out of the answer', () => {
    const checks = [
      ...bills(4, () => [dish('steak', 'Mains'), dish('wine', 'Red wine')]),
      ...bills(10, () => [dish('steak', 'Mains'), dish('coke', 'Soft Drinks')])
        .map((c) => ({ ...c, createdByName: 'Guest QR Order' })),
    ]
    const out = buildPairingExplorer(checks, { kind: 'dish', dishId: 'steak' })
    expect(out.subjectBills).toBe(4)
    expect(out.meta.selfOrderChecks).toBe(10)
    expect(out.rows.some((r) => r.dishId === 'coke')).toBe(false)
  })

  it('returns an empty answer for a subject that never sold', () => {
    const checks = bills(3, () => [dish('steak', 'Mains'), dish('wine', 'Red wine')])
    const out = buildPairingExplorer(checks, { kind: 'dish', dishId: 'never-sold' })
    expect(out.subject).toBeNull()
    expect(out.subjectBills).toBe(0)
    expect(out.rows).toEqual([])
  })

  it('reports lines that were never costed, so profit is read with care', () => {
    const checks = bills(4, () => [
      dish('steak', 'Mains'),
      dish('wine', 'Red wine', 8000, null),
    ])
    const out = buildPairingExplorer(checks, { kind: 'dish', dishId: 'steak' })
    expect(out.rows[0].uncostedLines).toBe(4)
    expect(out.meta.uncostedLines).toBe(4)
  })
})
