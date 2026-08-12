import { describe, expect, it } from 'vitest'
import { findItemNameCompletion, lastEntryPerItem } from '@/lib/inventorySuggestions'

function entry(name: string, createdAt: string, supplier: string | null = null) {
  return { ingredient: { name }, createdAt, supplier }
}

describe('lastEntryPerItem', () => {
  it('keeps only the most recently recorded entry for each item, newest first', () => {
    const rows = [
      entry('Tomatoes', '2026-08-01T10:00:00.000Z', 'SDK'),
      entry('Tomatoes', '2026-08-10T10:00:00.000Z', 'Pilek'),
      entry('Cooking Oil', '2026-08-05T10:00:00.000Z'),
    ]

    expect(lastEntryPerItem(rows).map((row) => [row.ingredient.name, row.supplier])).toEqual([
      ['Tomatoes', 'Pilek'],
      ['Cooking Oil', null],
    ])
  })

  it('treats names differing only by case or padding as the same item', () => {
    const rows = [entry('Tomatoes', '2026-08-01T10:00:00.000Z'), entry('  tomatoes ', '2026-08-09T10:00:00.000Z')]

    expect(lastEntryPerItem(rows)).toHaveLength(1)
  })
})

describe('findItemNameCompletion', () => {
  const rows = [
    entry('Tomatoes', '2026-08-01T10:00:00.000Z', 'SDK Suppliers'),
    entry('Cooking Oil', '2026-08-02T10:00:00.000Z'),
  ]

  it('completes a prefix and reports the untyped tail', () => {
    const completion = findItemNameCompletion(rows, 't')

    expect(completion?.itemName).toBe('Tomatoes')
    expect(completion?.remainder).toBe('omatoes')
  })

  it('offers the entry the user recorded most recently for that item', () => {
    // The user ignored the SDK suggestion and typed their own Pilek row; that
    // is what typing "t" has to offer from then on.
    const withCorrection = [...rows, entry('Tomatoes', '2026-08-11T10:00:00.000Z', 'Pilek Suppliers')]

    expect(findItemNameCompletion(withCorrection, 't')?.entry.supplier).toBe('Pilek Suppliers')
  })

  it('matches regardless of case and keeps the saved capitalisation', () => {
    const completion = findItemNameCompletion(rows, 'TOM')

    expect(completion?.itemName).toBe('Tomatoes')
    expect(completion?.remainder).toBe('atoes')
  })

  it('carries the completion across a word boundary', () => {
    const completion = findItemNameCompletion(rows, 'Cooking')

    expect(completion?.remainder).toBe(' Oil')
  })

  it('offers nothing once the typed name is already complete', () => {
    expect(findItemNameCompletion(rows, 'Tomatoes')).toBeNull()
    expect(findItemNameCompletion(rows, 'tomatoes')).toBeNull()
  })

  it('offers nothing for an empty field or an unknown item', () => {
    expect(findItemNameCompletion(rows, '')).toBeNull()
    expect(findItemNameCompletion(rows, '   ')).toBeNull()
    expect(findItemNameCompletion(rows, 'Zucchini')).toBeNull()
  })
})
