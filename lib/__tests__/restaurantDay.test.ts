/**
 * A "day" here is a day at the restaurant (UTC+2), not a day on the server.
 *
 * Both bugs these cover only ever appeared in production: the server runs UTC,
 * while a developer machine set to Kigali time parses the old code correctly and
 * shows nothing wrong.
 */

import { describe, it, expect } from 'vitest'

import { endOfRestaurantDay, restaurantHourOfDay, startOfRestaurantDay } from '../restaurantDay'

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

describe('restaurantHourOfDay', () => {
  it('reads the hour at the restaurant, not on the server', () => {
    // 17:30 UTC is the 19:00 dinner hour in Kigali. getHours() on a UTC server
    // would call this hour 17 and move the whole dinner service two hours
    // earlier — in production only.
    expect(restaurantHourOfDay(new Date('2026-08-01T17:30:00.000Z'))).toBe(19)
  })

  it('rolls past midnight into the small hours, not back to the morning', () => {
    // 23:30 UTC is 01:30 the next day in Kigali: late service, hour 1.
    expect(restaurantHourOfDay(new Date('2026-08-01T23:30:00.000Z'))).toBe(1)
    // 22:00 UTC is exactly Kigali midnight.
    expect(restaurantHourOfDay(new Date('2026-08-01T22:00:00.000Z'))).toBe(0)
  })

  it('accepts the shapes an order timestamp arrives in', () => {
    expect(restaurantHourOfDay('2026-08-01T17:30:00.000Z')).toBe(19)
    expect(restaurantHourOfDay(new Date('2026-08-01T17:30:00.000Z').getTime())).toBe(19)
  })

  it('returns NaN rather than a plausible midnight for an unusable value', () => {
    // Bucketing an unreadable timestamp as hour 0 would invent a late-night
    // trade that never happened.
    expect(Number.isNaN(restaurantHourOfDay('not-a-date'))).toBe(true)
  })
})
