/**
 * A "day" here is a day at the restaurant (UTC+2), not a day on the server.
 *
 * Both bugs these cover only ever appeared in production: the server runs UTC,
 * while a developer machine set to Kigali time parses the old code correctly and
 * shows nothing wrong.
 */

import { describe, it, expect } from 'vitest'

import { endOfRestaurantDay, startOfRestaurantDay } from '../restaurantDay'

describe('restaurant day boundaries', () => {
  it('starts the day at Kigali midnight, not UTC midnight', () => {
    // 00:00 in Kigali is 22:00 the previous day in UTC.
    expect(startOfRestaurantDay('2026-07-24')?.toISOString()).toBe('2026-07-23T22:00:00.000Z')
  })

  it('ends the day just before the next Kigali midnight', () => {
    expect(endOfRestaurantDay('2026-07-24')?.toISOString()).toBe('2026-07-24T21:59:59.999Z')
  })

  it('spans a real window for a single day, not a zero-width one', () => {
    // Passing the same YYYY-MM-DD to both ends used to produce gte === lte,
    // so a one-day query matched only sales at exactly 00:00:00.000 UTC.
    const start = startOfRestaurantDay('2026-07-23')!
    const end = endOfRestaurantDay('2026-07-23')!
    expect(end.getTime()).toBeGreaterThan(start.getTime())
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000 - 1)
  })

  it('puts an order taken just after midnight on that new restaurant day', () => {
    // 00:14 Kigali on the 24th == 22:14 UTC on the 23rd. Reports filtering in UTC
    // pushed these late-night orders onto the previous day, so revenue and cost
    // of goods disagreed about which day a sale belonged to.
    const paidAt = new Date('2026-07-23T22:14:50.995Z')
    const start = startOfRestaurantDay('2026-07-24')!
    const end = endOfRestaurantDay('2026-07-24')!
    expect(paidAt >= start && paidAt <= end).toBe(true)

    const previousDayEnd = endOfRestaurantDay('2026-07-23')!
    expect(paidAt > previousDayEnd).toBe(true)
  })

  it('returns null for missing or unparseable input', () => {
    expect(startOfRestaurantDay(null)).toBeNull()
    expect(startOfRestaurantDay('')).toBeNull()
    expect(endOfRestaurantDay(undefined)).toBeNull()
    expect(startOfRestaurantDay('not-a-date')).toBeNull()
  })
})
