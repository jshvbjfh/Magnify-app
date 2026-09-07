import { describe, it, expect } from 'vitest'
import { restaurantDayKey, startOfRestaurantDay, endOfRestaurantDay } from '@/lib/restaurantDay'

// Kigali runs at UTC+2 with no daylight saving, so the restaurant day and the
// UTC day disagree for the first two hours of every date. Every one of these
// cases is a real moment a till is open.
describe('restaurantDayKey', () => {
  it('names the local day during late service, when UTC is still yesterday', () => {
    // 01:00 in Kigali on the 8th is 23:00 UTC on the 7th. toISOString() would
    // say the 7th — the bug this function exists to prevent.
    expect(restaurantDayKey(new Date('2026-09-07T23:00:00.000Z'))).toBe('2026-09-08')
  })

  it('agrees with UTC during the day', () => {
    expect(restaurantDayKey(new Date('2026-09-08T12:00:00.000Z'))).toBe('2026-09-08')
  })

  it('rolls at local midnight, not UTC midnight', () => {
    // 21:59:59 UTC is 23:59:59 local — still the 7th.
    expect(restaurantDayKey(new Date('2026-09-07T21:59:59.999Z'))).toBe('2026-09-07')
    // 22:00:00 UTC is 00:00:00 local on the 8th.
    expect(restaurantDayKey(new Date('2026-09-07T22:00:00.000Z'))).toBe('2026-09-08')
  })

  it('falls back to now rather than returning a wrong-looking date', () => {
    expect(restaurantDayKey('not a date')).toBe(restaurantDayKey(new Date()))
  })

  it('produces a key the day-window helpers accept', () => {
    // The two halves have to fit: this makes the key, those make the window.
    const key = restaurantDayKey(new Date('2026-09-07T23:00:00.000Z'))
    const start = startOfRestaurantDay(key)!
    const end = endOfRestaurantDay(key)!

    expect(start.toISOString()).toBe('2026-09-07T22:00:00.000Z')
    expect(end.toISOString()).toBe('2026-09-08T21:59:59.999Z')
    // And the instant that produced the key falls inside its own window.
    const instant = new Date('2026-09-07T23:00:00.000Z')
    expect(instant >= start && instant <= end).toBe(true)
  })
})
