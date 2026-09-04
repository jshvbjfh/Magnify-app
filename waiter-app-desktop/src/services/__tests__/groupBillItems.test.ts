/**
 * Bill lines group for printing, and ONLY for printing.
 *
 * A guest who orders a beer at 4pm and another at 6pm gets two order rows, two
 * kitchen tickets and two entries in the order history — that timeline is the
 * restaurant's record and it must survive. What they should NOT get is a bill
 * that reads back the timeline as three separate 5,000 lines. So the grouping
 * happens at print time and the rows handed in are never touched.
 *
 * The other half of the rule is what must NOT merge. Two lines that differ in
 * price, discount or note are different things to the guest and to the kitchen,
 * and collapsing them would print a figure that cannot be checked against the
 * menu.
 */

import { describe, expect, it } from 'vitest'

import { groupBillItems, lineNetAmount } from '../db'

type Line = {
  dish_id: string | null
  dish_name: string
  dish_price: number
  qty: number
  discount_percent?: number | null
  notes?: string | null
}

const line = (over: Partial<Line> = {}): Line => ({
  dish_id: 'dish-heineken',
  dish_name: 'Heineken',
  dish_price: 5000,
  qty: 1,
  discount_percent: null,
  notes: null,
  ...over,
})

describe('groupBillItems', () => {
  it('collapses the same dish ordered in separate rounds', () => {
    // The bill from the venue that reported this: three beers, three rows,
    // because they arrived as three rounds over a two-hour table.
    const grouped = groupBillItems([line(), line(), line()])

    expect(grouped).toHaveLength(1)
    expect(grouped[0].qty).toBe(3)
    // 3 x 5,000 — the figure that must reach the TOTAL.
    expect(lineNetAmount(grouped[0])).toBe(15000)
  })

  it('does not touch the rows it was given', () => {
    // The order's own rows are the kitchen's and the auditor's record. Printing
    // a bill must not edit them, or the second print would count them twice.
    const rows = [line(), line()]

    groupBillItems(rows)

    expect(rows.map(r => r.qty)).toEqual([1, 1])
  })

  it('keeps lines apart when the price differs', () => {
    // Same beer, happy-hour price on one round. Merging them would print a
    // quantity at a unit price that was never charged.
    const grouped = groupBillItems([line(), line({ dish_price: 3000 })])

    expect(grouped).toHaveLength(2)
    expect(grouped.map(g => [g.qty, g.dish_price])).toEqual([[1, 5000], [1, 3000]])
  })

  it('keeps lines apart when the discount differs', () => {
    const grouped = groupBillItems([line(), line({ discount_percent: 50 })])

    expect(grouped).toHaveLength(2)
    expect(lineNetAmount(grouped[0])).toBe(5000)
    expect(lineNetAmount(grouped[1])).toBe(2500)
  })

  it('keeps lines apart when the note differs', () => {
    // "no ice" is a different thing to the kitchen and to the guest.
    const grouped = groupBillItems([line({ notes: 'no ice' }), line()])

    expect(grouped).toHaveLength(2)
  })

  it('merges lines whose notes differ only by surrounding space', () => {
    const grouped = groupBillItems([line({ notes: 'no ice' }), line({ notes: '  no ice  ' })])

    expect(grouped).toHaveLength(1)
    expect(grouped[0].qty).toBe(2)
  })

  it('groups by name when the dish id is missing', () => {
    // A deactivated dish can leave the row without an id; the name is then all
    // there is to go on, and two lines of it are still one line on the bill.
    const grouped = groupBillItems([
      line({ dish_id: null }),
      line({ dish_id: null }),
      line({ dish_id: null, dish_name: 'Mutzig' }),
    ])

    expect(grouped.map(g => [g.dish_name, g.qty])).toEqual([['Heineken', 2], ['Mutzig', 1]])
  })

  it('keeps the order the table ordered in', () => {
    const grouped = groupBillItems([
      line({ dish_id: 'd-starter', dish_name: 'Bruschetta' }),
      line(),
      line({ dish_id: 'd-starter', dish_name: 'Bruschetta' }),
    ])

    // The starter came first and stays first, even though its second row came
    // after the beer.
    expect(grouped.map(g => [g.dish_name, g.qty])).toEqual([['Bruschetta', 2], ['Heineken', 1]])
  })

  it('sums quantities that are already above one', () => {
    const grouped = groupBillItems([line({ qty: 2 }), line({ qty: 3 })])

    expect(grouped[0].qty).toBe(5)
    expect(lineNetAmount(grouped[0])).toBe(25000)
  })

  it('leaves the total unchanged', () => {
    // The whole point: grouping is a printing concern. What the guest owes is
    // identical either way, or the bill and the till would disagree.
    const rows = [
      line(), line(), line(),
      line({ dish_id: 'd-chicken', dish_name: 'Chicken Parmigiana', dish_price: 19800, discount_percent: 49.4 }),
    ]
    const sum = (ls: Line[]) => ls.reduce((s, l) => s + lineNetAmount(l), 0)

    expect(sum(groupBillItems(rows))).toBeCloseTo(sum(rows), 9)
  })
})
