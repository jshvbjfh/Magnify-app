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

// Same offset as above, in minutes, parsed from the one constant so the two can
// never drift apart.
const RESTAURANT_OFFSET_MINUTES = (() => {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(RESTAURANT_UTC_OFFSET)
  if (!match) return 0
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]))
})()

/**
 * Clock hour (0–23) at the restaurant for an instant.
 *
 * `getHours()` would read the hour in the SERVER's zone — UTC on Vercel — so an
 * order rung up at 20:30 in Kigali would report as hour 18 in production and
 * hour 20 on a developer machine set to Kigali time. Same trap as the day
 * boundaries above, and just as invisible until the numbers are already wrong.
 *
 * Returns NaN for an unparseable value rather than a plausible-looking 0, so
 * callers bucket it as unknown instead of silently piling it into midnight.
 */
export function restaurantHourOfDay(value: Date | string | number): number {
  const date = value instanceof Date ? value : new Date(value)
  const time = date.getTime()
  if (Number.isNaN(time)) return Number.NaN
  return new Date(time + RESTAURANT_OFFSET_MINUTES * 60_000).getUTCHours()
}

/**
 * Is this hour inside the chosen service window?
 *
 * Wraps past midnight on purpose: a window of 18→02 is one evening's service,
 * not an empty range, so `from > to` reads as "either side of midnight" rather
 * than nothing. Both ends are inclusive — a manager picking 18 to 22 means the
 * whole of the 22:00 hour, not up to 22:00 exactly.
 *
 * An unplaceable hour (NaN, from a row with no usable timestamp) is excluded
 * whenever a window is set: it cannot be shown to be inside one. With no window
 * everything passes, so callers can apply this unconditionally.
 */
export function isRestaurantHourInWindow(
  hour: number,
  from?: number | null,
  to?: number | null,
): boolean {
  if (from === null || from === undefined || to === null || to === undefined) return true
  if (!Number.isInteger(hour)) return false
  if (from <= to) return hour >= from && hour <= to
  return hour >= from || hour <= to
}

/** A chosen service window. Null is the whole trading day. */
export type RestaurantHourWindow = { from: number; to: number } | null

/**
 * Named services, because a manager reaches for "dinner" rather than for "18".
 * Both ends are inclusive hour blocks, so Dinner covers 18:00 through 22:59.
 *
 * Shared so every screen offering a time filter offers the SAME services — two
 * screens each with their own idea of when lunch starts produce two different
 * lunch figures, and nothing on either says why.
 */
export const RESTAURANT_HOUR_PRESETS: { id: string; label: string; window: RestaurantHourWindow }[] = [
  { id: 'all', label: 'All day', window: null },
  { id: 'breakfast', label: 'Breakfast', window: { from: 6, to: 10 } },
  { id: 'lunch', label: 'Lunch', window: { from: 11, to: 15 } },
  { id: 'dinner', label: 'Dinner', window: { from: 18, to: 22 } },
  // Wraps past midnight on purpose — late service is one window, not two.
  { id: 'late', label: 'Late night', window: { from: 22, to: 2 } },
]

/**
 * Read ?hourFrom=&hourTo= off a report request. Anything that is not a whole
 * hour 0–23 is treated as absent, so a malformed value widens the report to the
 * whole day rather than silently returning nothing.
 */
export function parseHourWindow(searchParams: URLSearchParams): { hourFrom: number | null; hourTo: number | null } {
  const parse = (raw: string | null): number | null => {
    if (raw === null || raw.trim() === '') return null
    const hour = Number(raw)
    return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null
  }
  const hourFrom = parse(searchParams.get('hourFrom'))
  const hourTo = parse(searchParams.get('hourTo'))
  // Half a window is not a window — one end alone would silently cut the report
  // at midnight in whichever direction happened to be supplied.
  if (hourFrom === null || hourTo === null) return { hourFrom: null, hourTo: null }
  return { hourFrom, hourTo }
}
