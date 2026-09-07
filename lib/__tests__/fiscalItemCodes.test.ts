import { describe, it, expect } from 'vitest'
import {
  formatItemCode,
  highestIssuedSequence,
  nextItemCodes,
  summarizeItemCodes,
} from '@/lib/fiscalItemCodes'

const item = (id: string, name: string, itemCode?: string | null) => ({ id, name, itemCode })

describe('formatItemCode', () => {
  it('pads to a fixed width so codes sort as they were issued', () => {
    expect(formatItemCode(1)).toBe('MG0000001')
    expect(formatItemCode(42)).toBe('MG0000042')
  })

  it('stays inside the twenty characters itemCd allows', () => {
    expect(formatItemCode(9_999_999).length).toBeLessThanOrEqual(20)
  })
})

describe('highestIssuedSequence', () => {
  it('finds the highest code this app issued', () => {
    expect(highestIssuedSequence([item('a', 'Beer', 'MG0000003'), item('b', 'Fanta', 'MG0000011')])).toBe(11)
  })

  it('ignores codes imported from another system', () => {
    // A venue arriving with its own codes keeps them. Letting a foreign code
    // drive our sequence would either collide or skip millions of numbers.
    expect(highestIssuedSequence([item('a', 'Beer', 'SKU-9931'), item('b', 'Fanta', 'MG0000004')])).toBe(4)
  })

  it('is zero when nothing has been issued', () => {
    expect(highestIssuedSequence([item('a', 'Beer', null)])).toBe(0)
  })
})

describe('nextItemCodes', () => {
  it('assigns only to items with no code, continuing the sequence', () => {
    const plan = nextItemCodes([
      item('a', 'Beer', 'MG0000001'),
      item('b', 'Fanta', null),
      item('c', 'Water', '   '),
    ])

    expect(plan).toEqual([
      { id: 'b', name: 'Fanta', itemCode: 'MG0000002' },
      { id: 'c', name: 'Water', itemCode: 'MG0000003' },
    ])
  })

  it('never reissues a code that exists', () => {
    // The whole point: a code on a filed declaration must not move.
    const existing = [item('a', 'Beer', 'MG0000007')]
    expect(nextItemCodes(existing)).toEqual([])
  })

  it('is idempotent — a second run has nothing left to do', () => {
    const items = [item('a', 'Beer', null), item('b', 'Fanta', null)]
    const first = nextItemCodes(items)
    const after = items.map((row) => {
      const assignment = first.find((entry) => entry.id === row.id)
      return assignment ? { ...row, itemCode: assignment.itemCode } : row
    })
    expect(nextItemCodes(after)).toEqual([])
  })

  it('does not collide with an imported code that looks like ours', () => {
    const plan = nextItemCodes([item('a', 'Beer', 'MG0000050'), item('b', 'Fanta', null)])
    expect(plan[0].itemCode).toBe('MG0000051')
  })
})

describe('summarizeItemCodes', () => {
  it('counts coverage', () => {
    const summary = summarizeItemCodes([item('a', 'Beer', 'MG0000001'), item('b', 'Fanta', null)])
    expect(summary.total).toBe(2)
    expect(summary.coded).toBe(1)
    expect(summary.missing).toBe(1)
    expect(summary.ready).toBe(false)
    expect(summary.concern).toBe('1 item(s) have no code yet')
  })

  it('reports a shared code rather than repairing it', () => {
    const summary = summarizeItemCodes([
      item('a', 'Beer', 'MG0000001'),
      item('b', 'Fanta', 'MG0000001'),
    ])
    expect(summary.duplicates).toHaveLength(1)
    expect(summary.duplicates[0].itemCode).toBe('MG0000001')
    expect(summary.duplicates[0].items.map((row) => row.id)).toEqual(['a', 'b'])
    expect(summary.ready).toBe(false)
  })

  it('leads with the clash when a menu has both problems', () => {
    // A duplicate is the graver of the two: a gap can be filled safely, a clash
    // needs somebody to decide which item keeps the code.
    const summary = summarizeItemCodes([
      item('a', 'Beer', 'MG0000001'),
      item('b', 'Fanta', 'MG0000001'),
      item('c', 'Water', null),
    ])
    expect(summary.concern).toBe('1 item code(s) are used by more than one item')
  })

  it('is ready when every item has its own code', () => {
    const summary = summarizeItemCodes([item('a', 'Beer', 'MG0000001'), item('b', 'Fanta', 'MG0000002')])
    expect(summary.ready).toBe(true)
    expect(summary.concern).toBeNull()
  })
})
