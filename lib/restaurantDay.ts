/**
 * Day boundaries for report/query date params.
 *
 * A "day" in this app means a day at the restaurant, not a day in UTC. Parsing
 * `YYYY-MM-DD` with `new Date()` gets this wrong twice over:
 *
 *   new Date('2026-07-24T00:00:00')  -> midnight in the SERVER's zone (UTC on
 *                                       Vercel), which is 02:00 Kigali, so an
 *                                       order taken at 00:30 lands on the wrong
 *                                       day — and only in production, never on a
 *                                       developer machine set to Kigali time.
 *   new Date('2026-07-24')           -> UTC midnight. Used for BOTH ends of a
 *                                       same-day range this produced a
 *                                       zero-width window that matched nothing.
 *
 * Rwanda is UTC+2 year-round with no daylight saving, so a fixed offset is exact
 * and avoids pulling in a timezone library.
 */
export const RESTAURANT_UTC_OFFSET = '+02:00'

/** First instant of the given calendar day at the restaurant. */
export function startOfRestaurantDay(value: string | null | undefined): Date | null {
  if (!value) return null
  const parsed = new Date(`${value}T00:00:00.000${RESTAURANT_UTC_OFFSET}`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** Last instant of the given calendar day at the restaurant (inclusive). */
export function endOfRestaurantDay(value: string | null | undefined): Date | null {
  if (!value) return null
  const parsed = new Date(`${value}T23:59:59.999${RESTAURANT_UTC_OFFSET}`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}
