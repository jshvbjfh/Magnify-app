import { describe, expect, it } from 'vitest'

import { categoryGroupKey } from '@/lib/menuMetadata'
import { isRestaurantHourInWindow, parseHourWindow } from '@/lib/restaurantDay'

describe('isRestaurantHourInWindow', () => {
  it('includes both ends of the window', () => {
    // A manager picking 18 to 22 means the whole of the 22:00 hour.
    expect(isRestaurantHourInWindow(18, 18, 22)).toBe(true)
    expect(isRestaurantHourInWindow(22, 18, 22)).toBe(true)
    expect(isRestaurantHourInWindow(17, 18, 22)).toBe(false)
    expect(isRestaurantHourInWindow(23, 18, 22)).toBe(false)
  })

  it('wraps past midnight, because late service is one window and not two', () => {
    expect(isRestaurantHourInWindow(23, 22, 2)).toBe(true)
    expect(isRestaurantHourInWindow(0, 22, 2)).toBe(true)
    expect(isRestaurantHourInWindow(2, 22, 2)).toBe(true)
    expect(isRestaurantHourInWindow(3, 22, 2)).toBe(false)
    expect(isRestaurantHourInWindow(12, 22, 2)).toBe(false)
  })

  it('passes everything when no window is set', () => {
    expect(isRestaurantHourInWindow(4, null, null)).toBe(true)
    expect(isRestaurantHourInWindow(Number.NaN, null, null)).toBe(true)
  })

  it('excludes an unplaceable hour once a window exists', () => {
    // A row with no usable timestamp cannot be shown to be inside the window,
    // so it must not be counted into one.
    expect(isRestaurantHourInWindow(Number.NaN, 18, 22)).toBe(false)
  })
})

describe('parseHourWindow', () => {
  const win = (qs: string) => parseHourWindow(new URLSearchParams(qs))

  it('reads a whole window', () => {
    expect(win('hourFrom=18&hourTo=22')).toEqual({ hourFrom: 18, hourTo: 22 })
    expect(win('hourFrom=22&hourTo=2')).toEqual({ hourFrom: 22, hourTo: 2 })
  })

  it('treats half a window as no window', () => {
    // One end alone would silently cut the report at midnight in whichever
    // direction happened to be supplied.
    expect(win('hourFrom=18')).toEqual({ hourFrom: null, hourTo: null })
    expect(win('hourTo=22')).toEqual({ hourFrom: null, hourTo: null })
  })

  it('widens to the whole day rather than returning nothing on a bad value', () => {
    expect(win('hourFrom=abc&hourTo=22')).toEqual({ hourFrom: null, hourTo: null })
    expect(win('hourFrom=-1&hourTo=22')).toEqual({ hourFrom: null, hourTo: null })
    expect(win('hourFrom=18&hourTo=24')).toEqual({ hourFrom: null, hourTo: null })
    expect(win('hourFrom=18.5&hourTo=22')).toEqual({ hourFrom: null, hourTo: null })
  })

  it('reads midnight as a real hour, not as absent', () => {
    expect(win('hourFrom=0&hourTo=5')).toEqual({ hourFrom: 0, hourTo: 5 })
  })
})

describe('categoryGroupKey', () => {
  it('folds the spellings the live menu actually carries', () => {
    // Three rows on SIROCCO's menu covering 35 dishes between them.
    const mains = ['Mains dish', 'Main Dish', 'Mains Dish'].map(categoryGroupKey)
    expect(new Set(mains).size).toBe(1)

    // Three more covering 22, differing only in spacing and case.
    const starters = ['Starters / Meze', 'Starters/meze', 'Starters/Meze'].map(categoryGroupKey)
    expect(new Set(starters).size).toBe(1)

    expect(categoryGroupKey('Sides')).toBe(categoryGroupKey('sides'))
  })

  it('keeps genuinely different categories apart', () => {
    // Folding a typo would mean guessing at spelling distance, which merges two
    // categories that really are different the first time a menu has both.
    expect(categoryGroupKey('Mains dishe')).not.toBe(categoryGroupKey('Mains dish'))
    expect(categoryGroupKey('Desserts')).not.toBe(categoryGroupKey('Drinks'))
    expect(categoryGroupKey('Red wine')).not.toBe(categoryGroupKey('White wine'))
  })

  it('does not strip a plural off a short word that needs it', () => {
    // "Gas" and "Ice" must not collapse into each other or lose their meaning.
    expect(categoryGroupKey('Gas')).toBe('gas')
    expect(categoryGroupKey('Ice')).toBe('ice')
  })

  it('returns an empty key for nothing, so callers can fall back', () => {
    expect(categoryGroupKey('')).toBe('')
    expect(categoryGroupKey(null)).toBe('')
    expect(categoryGroupKey(undefined)).toBe('')
    expect(categoryGroupKey('   ')).toBe('')
  })
})
