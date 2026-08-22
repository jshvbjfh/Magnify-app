import { calculateLineNetAmount } from '@/lib/restaurantOrders'
import { restaurantHourOfDay } from '@/lib/restaurantDay'
import { normalizeDishMenuType } from '@/lib/menuMetadata'

// Upsell & attachments — which product pairings make money, and which waiters
// reproduce them.
//
// The unit of analysis is the WHOLE CHECK, restaurant-wide, never a station's
// slice of it. A waiter who sells a burger (Grill) and a soda (Bar) made one
// upsell decision on one bill; scoping to Grill would show that check as
// "no drink attached" and report the opposite of what happened. This is the
// one report that deliberately ignores the per-station attribution used by
// branch-summary and dish-profitability.
//
// IMPORTANT: everything here measures ATTACHMENT — how often two items land on
// the same bill — not conversion. Nothing in the schema records that a waiter
// offered something and the guest declined, so a 0% rate may mean a waiter
// never asks, or that their tables never want one. Naming and copy must not
// imply otherwise.

export type UpsellGroup = 'food' | 'drink' | 'addon' | 'unknown'

/** Bills a waiter must have taken before their figures are ranked against the house. */
export const MIN_BILLS_FOR_COMPARISON = 20
/** Base-dish bills a pairing needs before its rate is treated as solid. */
export const CONFIDENCE_HIGH_BILLS = 100
export const CONFIDENCE_MEDIUM_BILLS = 15
/** A pairing is only worth showing once both sides clear these. */
export const PAIRING_MIN_BASE_BILLS = 8
export const PAIRING_MIN_TOGETHER = 4
/** A waiter must have served this many of the base dish to set the benchmark. */
export const BENCHMARK_MIN_WAITER_BILLS = 5
/** How many opportunities the headline figure and the UI list cover. */
export const OPPORTUNITY_LIMIT = 3
/**
 * Bills an hour needs before its attach rates are presented as a finding.
 *
 * Slicing a period by hour shrinks the sample hard — one hour of one day can be
 * three bills, and 0% or 100% off three bills is a data artifact, not a
 * performance signal. Hours under this floor still report their bill count and
 * their money, but the UI must show "—" for their rates rather than a
 * confident-looking percentage. Same reasoning as MIN_BILLS_FOR_COMPARISON.
 */
export const MIN_BILLS_FOR_HOURLY_RATE = 10

export type UpsellConfidence = 'high' | 'medium' | 'low'

export type UpsellLineItem = {
  dishId: string
  dishName: string
  category: string | null
  /**
   * The dish's menu section, set from a fixed dropdown in the menu editor.
   * Used only when the free-typed category is a word the classifier does not
   * recognise — see classifyItem.
   */
  menuType?: string | null
  qty: number
  dishPrice: number
  discountPercent?: number | null
  /** Actual FIFO food cost for this line, from DishSale. Null when never costed. */
  foodCost: number | null
}

export type UpsellCheck = {
  orderId: string
  staffId: string | null
  staffName: string | null
  createdByName: string | null
  totalAmount: number
  guestCount: number | null
  /**
   * When the order was RUNG UP, not when it was paid. The upsell decision
   * happens as the waiter takes the order, so a table seated at 19:00 and
   * settled at 22:00 is a 19:00 upsell — bucketing it by paidAt would report
   * the busy 19:00 service as a busy 22:00 one.
   */
  orderedAt: Date | string | number
  items: UpsellLineItem[]
}

export type UpsellServerRow = {
  serverKey: string
  serverName: string
  terminalAccount: string | null
  checks: number
  checksWithItems: number
  revenue: number
  avgCheck: number
  items: number
  itemsPerCheck: number
  addonChecks: number
  addonRate: number | null
  foodChecks: number
  drinkAttachChecks: number
  drinkAttachRate: number | null
  upsellRevenue: number
  upsellCost: number
  upsellProfit: number
  upsellMargin: number
  profitPerCheck: number
  /** Profit-per-bill gap to the house. Null when the waiter is below the volume floor. */
  vsHouse: number | null
  ranked: boolean
  upsellRevenueShare: number
  covers: number
  coveredChecks: number
  apc: number | null
}

/**
 * One clock hour at the restaurant. Deliberately the same shape as a server
 * row so it inherits the same null-vs-zero discipline from finalize(): an hour
 * that took no food bills reports drinkAttachRate as null, not as a 0% that
 * would read as "nobody attached a drink".
 *
 * `ranked` here means the hour cleared MIN_BILLS_FOR_HOURLY_RATE — enough bills
 * for its rates to be worth acting on.
 */
export type UpsellHourRow = UpsellServerRow & { hour: number }

export type UpsellPairing = {
  key: string
  baseDishId: string
  baseName: string
  attachDishId: string
  attachName: string
  attachGroup: Exclude<UpsellGroup, 'food' | 'unknown'>
  baseBills: number
  together: number
  attachRate: number
  /** Bills anywhere in the window that carried the attached item at all. */
  attachBills: number
  /**
   * How much more often the two land on one bill than chance alone would give:
   * P(both) / (P(base) x P(attach)).
   *
   * 1.0 is coincidence, 2.0+ is a real affinity, below 1.0 means the two
   * substitute for each other. Without this the report ranks by attach rate,
   * which crowns whatever is most popular: High 5ive's top opportunity,
   * "Signature Dumplings + SODA", scores 18% and reads as the biggest prize on
   * the menu, but its lift is 0.6 — guests take a soda with dumplings LESS
   * often than chance. Cocktail Juice, at lift 3.4 and more gross profit, does
   * not appear at all. Two of the three headline opportunities are artifacts of
   * soda being on half of all bills.
   *
   * Null when either side has no bills to divide by.
   */
  lift: number | null
  qty: number
  revenue: number
  cost: number
  profit: number
  margin: number
  confidence: UpsellConfidence
}

/** How a lift figure should be read. Thresholds live here so UI and copy agree. */
export type UpsellAffinity = 'real' | 'mild' | 'coincidence' | 'substitutes' | 'unknown'

export const LIFT_REAL = 2
export const LIFT_MILD = 1.2
export const LIFT_SUBSTITUTE = 0.8

export function affinityFor(lift: number | null): UpsellAffinity {
  if (lift === null || !Number.isFinite(lift)) return 'unknown'
  if (lift >= LIFT_REAL) return 'real'
  if (lift >= LIFT_MILD) return 'mild'
  if (lift >= LIFT_SUBSTITUTE) return 'coincidence'
  return 'substitutes'
}

/**
 * P(both) / (P(base) x P(attach)), reduced so it is one division of integers:
 * (together x bills) / (baseBills x attachBills).
 */
export function liftFor(
  together: number,
  baseBills: number,
  attachBills: number,
  bills: number
): number | null {
  if (baseBills <= 0 || attachBills <= 0 || bills <= 0) return null
  return (together * bills) / (baseBills * attachBills)
}

export type UpsellOpportunity = {
  key: string
  baseName: string
  attachName: string
  baseBills: number
  together: number
  houseRate: number
  bestServerName: string
  bestServerRate: number
  bestServerBills: number
  gapPoints: number
  /** Extra gross profit if the house matched that waiter on this pairing. */
  missedProfit: number
}

export type UpsellReport = {
  summary: {
    bills: number
    upsellRevenue: number
    upsellCost: number
    upsellProfit: number
    upsellMargin: number
    profitPerBill: number
    opportunity: number
    topServerName: string | null
    topServerRate: number | null
  }
  rows: UpsellServerRow[]
  house: UpsellServerRow
  pairings: UpsellPairing[]
  opportunities: UpsellOpportunity[]
  attachedItems: UpsellAttachedItem[]
  /**
   * The shape of the whole day, ALWAYS over the full date range and ignoring
   * any hour window — the profile is what a manager reads to decide which hours
   * are worth filtering to, so it must not collapse to the window already
   * chosen. Ordered by service, not 00→23; see orderHourAxis.
   */
  hourly: UpsellHourRow[]
  meta: {
    totalChecks: number
    serverChecks: number
    selfOrderChecks: number
    checksWithoutServer: number
    coveredChecks: number
    uncategorizedItems: number
    uncostedAttachLines: number
    /** Drink and add-on lines counted in the window. */
    attachLines: number
    /**
     * Of those, how many carried a food cost above zero.
     *
     * A line with no DishSale row and a line costed at exactly 0 are the same
     * number downstream, and only this counter tells them apart. Sirocco Y Sol
     * has a recipe for 1 of the 23 dishes it sells at lunch, so all 42 of its
     * lines arrive costed at zero: the report subtracts nothing, hands back the
     * revenue, and calls it "gross profit at a 100% margin". That figure is not
     * a margin, it is the absence of one — and a manager can budget against it.
     *
     * When this is 0 while attachLines is not, the caller must present revenue
     * and say the cost is unknown, never a profit or a margin.
     */
    attachLinesCosted: number
    pairingsTotal: number
    /** The window everything except `hourly` was computed over. Null when all day. */
    hourFrom: number | null
    hourTo: number | null
    /** Bills dropped by the hour window. Zero when no window is set. */
    checksOutsideWindow: number
  }
}

export type UpsellAttachedItem = {
  dishId: string
  dishName: string
  category: string | null
  group: UpsellGroup
  qty: number
  checks: number
  revenue: number
  profit: number
}

// Category values have drifted off the menu dropdown over time — the live menu
// carries both "Grill"/"Grills" and "Mocktail"/"Mocktails", and the dropdown
// says "Pizzas"/"Hot Drinks" where the data says "Pizza"/"Hot Beverages".
// Folding case and a trailing plural collapses those pairs so the report stops
// splitting one category into two rows. This is a read-side workaround, not a
// substitute for cleaning the menu data itself.
export function normalizeCategory(raw: string | null | undefined): string {
  const value = (raw ?? '').trim().toLowerCase()
  if (!value) return ''
  return value.length > 3 && value.endsWith('s') ? value.slice(0, -1) : value
}

// Things a guest says yes to on top of what they came in for.
const ADDON_CATEGORIES = new Set(['add-on', 'addon', 'side', 'dessert', 'sauce', 'extra', 'topping'])

const DRINK_CATEGORIES = new Set([
  'drink', 'soft drink', 'hot drink', 'hot beverage', 'beverage',
  'mocktail', 'cocktail', 'smoothie', 'smoothies & shake', 'shake',
  'juice', 'coffee', 'tea', 'water',
  'beer', 'wine', 'spirit', 'liquor',
])

/**
 * The category word alone — null when it is not a word we recognise.
 *
 * Split out from classifyCategory so a caller can tell "this is definitely a
 * drink" apart from "no idea, assume food". That difference is the whole point
 * of classifyItem below.
 */
function classifyCategoryWord(raw: string | null | undefined): UpsellGroup | null {
  const category = normalizeCategory(raw)
  if (!category) return null
  if (ADDON_CATEGORIES.has(category)) return 'addon'
  if (DRINK_CATEGORIES.has(category)) return 'drink'
  return null
}

export function classifyCategory(raw: string | null | undefined): UpsellGroup {
  const category = normalizeCategory(raw)
  if (!category) return 'unknown'
  // Anything else on the menu is something a guest came in to eat.
  return classifyCategoryWord(raw) ?? 'food'
}

/**
 * What a sold line actually is, using the category word first and the dish's
 * own menuType as the tie-breaker.
 *
 * The word list can only recognise categories someone thought to put in it, and
 * every restaurant names its menu differently. Sirocco Y Sol files wine under
 * "Red wine", "Rose wine", "Sparkling wines" and "white whine" (sic), coffee
 * under "Iced coffee" and "specialty brews", and juice under "Fresh juices" —
 * 43 of its 62 drinks. classifyCategory calls every one of them FOOD, which
 * breaks the drink-attach rate twice over: the bill is counted as a food bill
 * (inflating the denominator) and the sale never counts as an attached drink
 * (emptying the numerator).
 *
 * menuType already holds the right answer for all 43 — the menu editor sets it
 * from a fixed dropdown, so it cannot drift the way free-typed category text
 * does. Reading it costs one extra column on the dish query and needs no
 * migration.
 *
 * Order matters: the category word wins when it is recognised, because it is
 * more specific ("Sides" is an add-on, though its menuType is also "sides"),
 * and menuType only decides the cases the word list cannot.
 */
export function classifyItem(item: {
  category?: string | null
  menuType?: string | null
}): UpsellGroup {
  const byWord = classifyCategoryWord(item.category)
  if (byWord) return byWord

  switch (normalizeDishMenuType(item.menuType)) {
    case 'drinks': return 'drink'
    case 'sides': return 'addon'
    case 'mains': return 'food'
  }

  // No usable signal either way: a named category we do not recognise is still
  // something the guest came in to eat; a blank one is genuinely unknown.
  return normalizeCategory(item.category) ? 'food' : 'unknown'
}

// Guests ordering for themselves at the table via the QR menu. There is no
// dedicated flag on the order — the submit route stamps the name and nothing
// else (app/api/order/[restaurantId]/submit/route.ts), so the name prefix is
// the only signal available. These bills must stay out of the ranking
// entirely: nobody was there to suggest a dessert, so scoring them as a missed
// upsell would punish staff for sales they never attended.
//
// A waiter confirming a QR order appends "· confirmed by <name>" but keeps the
// guest prefix, and that still isn't an upsell — the guest picked the items.
export function isSelfOrder(check: Pick<UpsellCheck, 'createdByName'>): boolean {
  const name = (check.createdByName ?? '').trim()
  return name === 'Guest QR Order' || name.startsWith('Guest - ')
}

// createdByName is the WAITER; the linked Staff row is the TERMINAL SCREEN's
// account, shared by everyone working that screen. Several waiters ring up
// under one terminal login (Kenny and Mimi both sell through "High 5ive
// waiter"), so keying on the staff record would merge them into one row and
// report the screen's performance instead of the person's. The typed name is
// the only per-waiter identity there is — see app/api/mobile/push/route.ts,
// which falls back to the terminal's account name only when the app sends none.
//
// Names are folded to lower case because the same waiter types "kenny" and
// "Kenny" on different nights.
function serverKeyFor(check: UpsellCheck): { key: string; name: string } {
  const name = (check.createdByName || check.staffName || '').trim()
  if (!name) return { key: '__unattributed__', name: 'Unattributed' }
  return { key: name.toLowerCase(), name }
}

/**
 * Is this hour inside the manager's chosen service window?
 *
 * Both ends are INCLUSIVE and name whole hour blocks: 18→22 is the five blocks
 * 18:00 through 22:59, which is what someone picking "dinner" means.
 *
 * Wrap-around windows are normal here, not an edge case — late service is
 * routinely 22→02, and the obvious `hour >= from && hour <= to` returns nothing
 * at all for it.
 *
 * An unplaceable hour (NaN, from an order with no usable timestamp) is excluded
 * whenever a window is set: it cannot be shown to be inside one.
 */
export function isHourInWindow(
  hour: number,
  from?: number | null,
  to?: number | null,
): boolean {
  if (from === null || from === undefined || to === null || to === undefined) return true
  if (!Number.isInteger(hour)) return false
  if (from <= to) return hour >= from && hour <= to
  return hour >= from || hour <= to
}

/**
 * Put the hour axis in service order rather than 00→23.
 *
 * A restaurant open 10:00–02:00 sorted numerically opens the chart at 01:00 and
 * closes it at 23:00, which reads as though the night ran backwards. The real
 * start of service is the hour following the longest stretch with no bills at
 * all — for that restaurant, the 03:00–09:00 dead zone — so the axis is rotated
 * to begin there and run through midnight.
 */
export function orderHourAxis(hours: number[]): number[] {
  const present = Array.from(new Set(hours.filter((hour) => Number.isInteger(hour) && hour >= 0 && hour <= 23)))
    .sort((a, b) => a - b)
  if (present.length < 2) return present

  let startIndex = 0
  let widestGap = -1
  for (let i = 0; i < present.length; i += 1) {
    const previous = present[(i - 1 + present.length) % present.length]
    const gap = (present[i] - previous + 24) % 24
    if (gap > widestGap) {
      widestGap = gap
      startIndex = i
    }
  }
  return [...present.slice(startIndex), ...present.slice(0, startIndex)]
}

export function confidenceFor(baseBills: number): UpsellConfidence {
  if (baseBills >= CONFIDENCE_HIGH_BILLS) return 'high'
  if (baseBills >= CONFIDENCE_MEDIUM_BILLS) return 'medium'
  return 'low'
}

function emptyRow(serverKey: string, serverName: string, terminalAccount: string | null): UpsellServerRow {
  return {
    serverKey, serverName, terminalAccount,
    checks: 0, checksWithItems: 0, revenue: 0, avgCheck: 0,
    items: 0, itemsPerCheck: 0,
    addonChecks: 0, addonRate: null,
    foodChecks: 0, drinkAttachChecks: 0, drinkAttachRate: null,
    upsellRevenue: 0, upsellCost: 0, upsellProfit: 0, upsellMargin: 0,
    profitPerCheck: 0, vsHouse: null, ranked: false,
    upsellRevenueShare: 0,
    covers: 0, coveredChecks: 0, apc: null,
  }
}

function round1(value: number) {
  return Math.round(value * 10) / 10
}

// Revenue from the guest-counted checks only, kept alongside the row so APC
// divides the same orders' revenue by the same orders' guests. Dropped before
// the row is returned.
type InternalRow = UpsellServerRow & { coveredRevenue__: number }

function finalize(row: InternalRow): InternalRow {
  row.avgCheck = row.checks > 0 ? Math.round(row.revenue / row.checks) : 0
  row.itemsPerCheck = row.checks > 0 ? round1(row.items / row.checks) : 0
  // Bills that carry a total but no line items exist in the history (voided or
  // never-itemised orders). Nothing can be attached to an empty bill, so they
  // stay out of the denominator instead of counting as a failed upsell.
  row.addonRate = row.checksWithItems > 0
    ? round1((row.addonChecks / row.checksWithItems) * 100)
    : null
  // Only food checks can have a drink "attached" — a guest who ordered nothing
  // but two beers wasn't upsold a drink, that was the visit. Null (not zero)
  // when a server took no food checks at all, so the UI can show "—" rather
  // than implying they failed at something they never had a chance to do.
  row.drinkAttachRate = row.foodChecks > 0
    ? round1((row.drinkAttachChecks / row.foodChecks) * 100)
    : null
  row.upsellProfit = row.upsellRevenue - row.upsellCost
  row.upsellMargin = row.upsellRevenue > 0 ? round1((row.upsellProfit / row.upsellRevenue) * 100) : 0
  row.profitPerCheck = row.checks > 0 ? Math.round(row.upsellProfit / row.checks) : 0
  row.upsellRevenueShare = row.revenue > 0 ? round1((row.upsellRevenue / row.revenue) * 100) : 0
  row.apc = row.covers > 0 ? Math.round(row.coveredRevenue__ / row.covers) : null
  return row
}

function stripInternal(row: InternalRow): UpsellServerRow {
  const { coveredRevenue__: _unused, ...rest } = row
  return rest
}

/** What one check contributes to any bucket it belongs to. */
type CheckTotals = {
  itemCount: number
  revenue: number
  lineCount: number
  upsellRevenue: number
  upsellCost: number
  hasFood: boolean
  hasDrink: boolean
  hasAddon: boolean
  guestCount: number | null
}

// One check folded into one bucket. Shared by the waiter rows, the house
// average and the hourly profile so a bill can never be counted one way in the
// table and another way in the chart.
function applyCheckToRow(target: InternalRow, totals: CheckTotals) {
  target.checks += 1
  if (totals.itemCount > 0) target.checksWithItems += 1
  target.revenue += totals.revenue
  target.items += totals.lineCount
  target.upsellRevenue += totals.upsellRevenue
  target.upsellCost += totals.upsellCost
  if (totals.hasAddon) target.addonChecks += 1
  if (totals.hasFood) {
    target.foodChecks += 1
    if (totals.hasDrink) target.drinkAttachChecks += 1
  }
  // Guest counts landed on 2026-08-09 and are null on everything before
  // that. Averaging revenue that has no guest count against the guests that
  // do roughly doubles the figure and still looks believable, so orders
  // without a count stay out of both sides — same rule as the dashboard APC.
  if ((totals.guestCount ?? 0) > 0) {
    target.covers += totals.guestCount as number
    target.coveredChecks += 1
    target.coveredRevenue__ += totals.revenue
  }
}

type PairAccumulator = {
  baseDishId: string
  baseName: string
  attachDishId: string
  attachName: string
  attachGroup: 'addon' | 'drink'
  together: number
  qty: number
  revenue: number
  cost: number
}

export type UpsellReportOptions = {
  /** Inclusive start of the service window, 0–23. Omit for the whole day. */
  hourFrom?: number | null
  /** Inclusive end of the service window, 0–23. May be lower than hourFrom for late service. */
  hourTo?: number | null
}

// ─── PAIRING EXPLORER ──────────────────────────────────────────────────────
//
// "What pairs with this?" — the drill-down behind the report's headline
// figures. The subject is one dish or one menu category; the answer is every
// other item that lands on the same bills, ranked by gross profit and marked
// with the lift that says whether the pairing is real.
//
// Deliberately NOT limited to add-ons and drinks the way the pairings table is:
// a manager asking what goes with a starter wants to know it pulls a main, and
// a cross-menu answer (a Food main pulling a Drinks·Alcoholic wine) is the
// whole point of the feature.

/** Bills a pairing needs before the explorer will list it at all. */
export const EXPLORER_MIN_TOGETHER = 3

export type PairingSubject =
  | { kind: 'dish'; dishId: string }
  | { kind: 'category'; category: string }

export type PairingExplorerRow = {
  dishId: string
  dishName: string
  category: string | null
  group: UpsellGroup
  /** Bills carrying both the subject and this item. */
  together: number
  /** Bills carrying this item at all, anywhere in scope. */
  attachBills: number
  /** together / subjectBills, as a percentage. */
  pairRate: number
  lift: number | null
  affinity: UpsellAffinity
  qty: number
  revenue: number
  cost: number
  profit: number
  /** Lines of this item that were never FIFO-costed, so profit understates. */
  uncostedLines: number
}

export type PairingExplorer = {
  subject: {
    kind: PairingSubject['kind']
    key: string
    label: string
    category: string | null
    group: UpsellGroup
  } | null
  /** Eligible bills in scope — the denominator every lift is computed against. */
  bills: number
  /** Bills carrying the subject. */
  subjectBills: number
  rows: PairingExplorerRow[]
  meta: {
    totalChecks: number
    selfOrderChecks: number
    /** Pairings that existed but fell under EXPLORER_MIN_TOGETHER. */
    belowFloor: number
    uncostedLines: number
  }
}

const EMPTY_EXPLORER: PairingExplorer = {
  subject: null,
  bills: 0,
  subjectBills: 0,
  rows: [],
  meta: { totalChecks: 0, selfOrderChecks: 0, belowFloor: 0, uncostedLines: 0 },
}

export function buildPairingExplorer(
  checks: UpsellCheck[],
  subject: PairingSubject,
  options: UpsellReportOptions = {},
): PairingExplorer {
  const { hourFrom = null, hourTo = null } = options

  const matchesSubject = (item: UpsellLineItem) =>
    subject.kind === 'dish'
      ? item.dishId === subject.dishId
      : normalizeCategory(item.category) === normalizeCategory(subject.category)

  // One pass to fix the scope, so every rate and every lift divides by the same
  // set of bills. Guest QR bills are excluded here for the same reason as
  // everywhere else in this report: nobody was there to suggest anything.
  const eligible: UpsellCheck[] = []
  let selfOrderChecks = 0
  for (const check of checks) {
    if (isSelfOrder(check)) { selfOrderChecks++; continue }
    const hour = restaurantHourOfDay(check.orderedAt)
    if (!isHourInWindow(hour, hourFrom, hourTo)) continue
    eligible.push(check)
  }
  if (eligible.length === 0) {
    return { ...EMPTY_EXPLORER, meta: { ...EMPTY_EXPLORER.meta, totalChecks: checks.length, selfOrderChecks } }
  }

  type Acc = {
    dishName: string
    category: string | null
    group: UpsellGroup
    together: number
    qty: number
    revenue: number
    cost: number
    uncostedLines: number
  }
  const pairs = new Map<string, Acc>()
  /** Bills carrying each dish at all — the lift denominator. */
  const itemBills = new Map<string, number>()
  let subjectBills = 0
  let subjectLabel = ''
  let subjectCategory: string | null = null
  let subjectGroup: UpsellGroup = 'unknown'
  let uncostedLines = 0

  for (const check of eligible) {
    // Deduplicated per bill on both sides: a dish rung twice is one bill that
    // carried it, and the subject appearing twice is still one opportunity.
    const onCheck = new Map<string, { item: UpsellLineItem; qty: number; revenue: number; cost: number; uncosted: number }>()
    let hasSubject = false

    for (const item of check.items) {
      if (matchesSubject(item)) {
        hasSubject = true
        if (!subjectLabel) {
          subjectLabel = subject.kind === 'dish' ? item.dishName : (item.category ?? subject.category)
          subjectCategory = item.category ?? null
          subjectGroup = classifyItem(item)
        }
      }
      const qty = Number(item.qty ?? 0)
      const revenue = calculateLineNetAmount({
        dishPrice: Number(item.dishPrice ?? 0),
        qty,
        discountPercent: item.discountPercent,
      })
      const costed = item.foodCost !== null && item.foodCost !== undefined
      const prev = onCheck.get(item.dishId)
      onCheck.set(item.dishId, {
        item,
        qty: (prev?.qty ?? 0) + qty,
        revenue: (prev?.revenue ?? 0) + revenue,
        cost: (prev?.cost ?? 0) + Number(item.foodCost ?? 0),
        uncosted: (prev?.uncosted ?? 0) + (costed ? 0 : 1),
      })
    }

    for (const dishId of onCheck.keys()) itemBills.set(dishId, (itemBills.get(dishId) ?? 0) + 1)
    if (!hasSubject) continue
    subjectBills++

    for (const [dishId, line] of onCheck) {
      // The subject never pairs with itself. For a category subject that means
      // dropping every dish in that category, not just the one dish matched —
      // "what goes with Burgers" must not answer "another burger".
      if (matchesSubject(line.item)) continue
      const acc = pairs.get(dishId) ?? {
        dishName: line.item.dishName,
        category: line.item.category ?? null,
        group: classifyItem(line.item),
        together: 0, qty: 0, revenue: 0, cost: 0, uncostedLines: 0,
      }
      acc.together += 1
      acc.qty += line.qty
      acc.revenue += line.revenue
      acc.cost += line.cost
      acc.uncostedLines += line.uncosted
      uncostedLines += line.uncosted
      pairs.set(dishId, acc)
    }
  }

  const bills = eligible.length
  const all: PairingExplorerRow[] = Array.from(pairs.entries()).map(([dishId, a]) => {
    const attachBills = itemBills.get(dishId) ?? 0
    const lift = liftFor(a.together, subjectBills, attachBills, bills)
    const rounded = lift === null ? null : Math.round(lift * 10) / 10
    return {
      dishId,
      dishName: a.dishName,
      category: a.category,
      group: a.group,
      together: a.together,
      attachBills,
      pairRate: subjectBills > 0 ? round1((a.together / subjectBills) * 100) : 0,
      lift: rounded,
      affinity: affinityFor(rounded),
      qty: a.qty,
      revenue: a.revenue,
      cost: a.cost,
      profit: a.revenue - a.cost,
      uncostedLines: a.uncostedLines,
    }
  })

  // Ranked by money, because that is what a manager acts on; lift is carried
  // alongside so a fat number with no affinity behind it is visibly marked
  // rather than silently promoted.
  const rows = all
    .filter((r) => r.together >= EXPLORER_MIN_TOGETHER)
    .sort((a, b) => b.profit - a.profit)

  return {
    subject: subjectBills > 0
      ? {
          kind: subject.kind,
          key: subject.kind === 'dish' ? subject.dishId : subject.category,
          label: subjectLabel,
          category: subjectCategory,
          group: subjectGroup,
        }
      : null,
    bills,
    subjectBills,
    rows,
    meta: {
      totalChecks: checks.length,
      selfOrderChecks,
      belowFloor: all.length - rows.length,
      uncostedLines,
    },
  }
}

export function buildUpsellingReport(
  checks: UpsellCheck[],
  options: UpsellReportOptions = {},
): UpsellReport {
  const hourFrom = Number.isInteger(options.hourFrom) ? (options.hourFrom as number) : null
  const hourTo = Number.isInteger(options.hourTo) ? (options.hourTo as number) : null
  // A half-specified window is not a window. Falling back to "all day" is the
  // safe reading: it shows more than asked rather than silently hiding bills.
  const windowActive = hourFrom !== null && hourTo !== null

  const byServer = new Map<string, InternalRow>()
  const house: InternalRow = { ...emptyRow('__house__', 'House average', null), coveredRevenue__: 0 }
  const attached = new Map<string, UpsellAttachedItem>()
  // The day's shape, built from every bill in the date range whether or not the
  // window keeps it — this is what the manager reads to choose a window.
  const byHour = new Map<number, InternalRow>()

  const pairs = new Map<string, PairAccumulator>()
  const baseBills = new Map<string, number>()
  // Per-waiter counts, so the benchmark is a rate one of your own staff has
  // actually achieved rather than an invented industry target.
  const serverBaseBills = new Map<string, number>()
  const serverPairBills = new Map<string, number>()
  const serverNames = new Map<string, string>()

  let checksWithoutServer = 0
  let coveredChecks = 0
  let uncategorizedItems = 0
  let selfOrderChecks = 0
  let serverChecks = 0
  let uncostedAttachLines = 0
  let attachLines = 0
  let attachLinesCosted = 0
  let checksOutsideWindow = 0

  for (const check of checks) {
    // A guest ordering for themselves on the QR menu is not a server's bill.
    // Counted for context, then dropped before any rate is computed.
    if (isSelfOrder(check)) {
      selfOrderChecks++
      continue
    }

    // Restaurant clock hour, never the server's — see restaurantHourOfDay.
    const hour = restaurantHourOfDay(check.orderedAt)
    const inWindow = isHourInWindow(hour, hourFrom, hourTo)
    if (!inWindow) checksOutsideWindow++

    const revenue = Number(check.totalAmount ?? 0)
    let hasFood = false
    let hasDrink = false
    let hasAddon = false
    let lineCount = 0
    let upsellRevenue = 0
    let upsellCost = 0

    // Deduplicated per bill: a dish ordered twice on one check is still one
    // opportunity to attach something, not two.
    const foodOnCheck = new Map<string, string>()
    const attachOnCheck = new Map<string, { name: string; group: 'addon' | 'drink'; qty: number; revenue: number; cost: number }>()
    /** Attach dishes already counted against this bill, so `checks` stays a bill count. */
    const attachSeenOnCheck = new Set<string>()

    for (const item of check.items) {
      const qty = Number(item.qty ?? 0)
      // Net of any discount: attach revenue is money actually taken, and
      // counting the menu price would flatter every upsell that was discounted.
      const lineRevenue = calculateLineNetAmount({
        dishPrice: Number(item.dishPrice ?? 0),
        qty,
        discountPercent: item.discountPercent,
      })
      const group = classifyItem(item)
      lineCount += qty
      if (group === 'food') { hasFood = true; foodOnCheck.set(item.dishId, item.dishName) }
      // The data-quality counters describe the tables below, which cover the
      // window only — counting bills the window excluded would report problems
      // in figures the manager is not being shown.
      if (group === 'unknown' && inWindow) uncategorizedItems++

      if (group === 'drink' || group === 'addon') {
        if (group === 'drink') hasDrink = true
        if (group === 'addon') hasAddon = true
        const cost = item.foodCost
        if ((cost === null || cost === undefined) && inWindow) uncostedAttachLines++
        const lineCost = Number(cost ?? 0)
        if (inWindow) {
          attachLines++
          // Above zero, not merely present: a dish with no recipe still gets a
          // DishSale row, and that row says the cost was nothing.
          if (lineCost > 0) attachLinesCosted++
        }
        upsellRevenue += lineRevenue
        upsellCost += lineCost

        const prev = attachOnCheck.get(item.dishId)
        attachOnCheck.set(item.dishId, {
          name: item.dishName,
          group,
          qty: (prev?.qty ?? 0) + qty,
          revenue: (prev?.revenue ?? 0) + lineRevenue,
          cost: (prev?.cost ?? 0) + lineCost,
        })

        if (inWindow) {
          const existing = attached.get(item.dishId)
          if (existing) {
            existing.qty += qty
            // Bills, not lines. A guest who orders a second round of the same
            // soda is one bill that took a soda, not two — counting the line
            // would inflate `checks` above the number of bills that exist and
            // make the lift denominator wrong for exactly the ubiquitous items
            // lift is meant to demote.
            if (!attachSeenOnCheck.has(item.dishId)) existing.checks += 1
            existing.revenue += lineRevenue
            existing.profit += lineRevenue - lineCost
          } else {
            attached.set(item.dishId, {
              dishId: item.dishId,
              dishName: item.dishName,
              category: item.category,
              group,
              qty,
              checks: 1,
              revenue: lineRevenue,
              profit: lineRevenue - lineCost,
            })
          }
          attachSeenOnCheck.add(item.dishId)
        }
      }
    }

    const totals: CheckTotals = {
      itemCount: check.items.length,
      revenue,
      lineCount,
      upsellRevenue,
      upsellCost,
      hasFood,
      hasDrink,
      hasAddon,
      guestCount: check.guestCount ?? null,
    }

    // The hourly profile takes every bill in the range, window or not.
    if (Number.isInteger(hour)) {
      let bucket = byHour.get(hour)
      if (!bucket) {
        bucket = { ...emptyRow(`hour-${hour}`, `${String(hour).padStart(2, '0')}:00`, null), coveredRevenue__: 0 }
        byHour.set(hour, bucket)
      }
      applyCheckToRow(bucket, totals)
    }

    // Everything past here describes the selected window only.
    if (!inWindow) continue

    serverChecks++
    const { key, name } = serverKeyFor(check)
    if (key === '__unattributed__') checksWithoutServer++
    serverNames.set(key, name)

    let row = byServer.get(key)
    if (!row) {
      row = { ...emptyRow(key, name, check.staffName ?? null), coveredRevenue__: 0 }
      byServer.set(key, row)
    }
    // Which screen they were ringing up on, for context only. First one seen
    // wins; a waiter who moves between terminals is still one row.
    if (!row.terminalAccount && check.staffName) row.terminalAccount = check.staffName

    // Pairings: every food item on the bill is a chance to have attached each
    // add-on or drink. Counted once per bill on both sides.
    for (const [baseDishId, baseName] of foodOnCheck) {
      baseBills.set(baseDishId, (baseBills.get(baseDishId) ?? 0) + 1)
      serverBaseBills.set(`${key} ${baseDishId}`, (serverBaseBills.get(`${key} ${baseDishId}`) ?? 0) + 1)

      for (const [attachDishId, a] of attachOnCheck) {
        const pairKey = `${baseDishId} ${attachDishId}`
        const acc = pairs.get(pairKey) ?? {
          baseDishId, baseName, attachDishId, attachName: a.name, attachGroup: a.group,
          together: 0, qty: 0, revenue: 0, cost: 0,
        }
        acc.together += 1
        acc.qty += a.qty
        acc.revenue += a.revenue
        acc.cost += a.cost
        pairs.set(pairKey, acc)
        serverPairBills.set(`${key} ${pairKey}`, (serverPairBills.get(`${key} ${pairKey}`) ?? 0) + 1)
      }
    }

    for (const target of [row, house]) applyCheckToRow(target, totals)
    if ((check.guestCount ?? 0) > 0) coveredChecks++
  }

  const finalizedHouse = finalize(house)

  // Hour buckets go through the same finalize() as the waiter rows, so their
  // rates carry the same meaning: null where there was never a chance to
  // attach anything, rather than a 0% that reads as a failure. `ranked` then
  // marks the hours that carry enough bills to be worth acting on.
  const hourly: UpsellHourRow[] = orderHourAxis(Array.from(byHour.keys())).map((hour) => {
    const bucket = finalize(byHour.get(hour) as InternalRow)
    bucket.ranked = bucket.checksWithItems >= MIN_BILLS_FOR_HOURLY_RATE
    return { hour, ...stripInternal(bucket) }
  })

  // Best attach rate first. Servers whose bills carried no items at all have no
  // rate to rank on and sort to the bottom rather than tying with a genuine 0%.
  const rows = Array.from(byServer.values()).map(finalize)
  for (const row of rows) {
    // Bills with items, not bills. A waiter whose orders carry no line items
    // (voided or never itemised) has demonstrated nothing, and ranking them
    // against the house puts a confident -7,659 next to a data artifact.
    row.ranked = row.checksWithItems >= MIN_BILLS_FOR_COMPARISON
    // A handful of bills is not a performance signal, so those rows carry no
    // comparison at all rather than a confident-looking number.
    row.vsHouse = row.ranked ? row.profitPerCheck - finalizedHouse.profitPerCheck : null
  }
  rows.sort((a, b) => {
    if (a.ranked !== b.ranked) return a.ranked ? -1 : 1
    return b.profitPerCheck - a.profitPerCheck
  })

  const allPairings: UpsellPairing[] = Array.from(pairs.entries()).map(([key, p]) => {
    const base = baseBills.get(p.baseDishId) ?? 0
    // Bills that carried the attached item at all, whatever else was on them.
    // This is the denominator that tells a genuine pairing apart from an item
    // that is simply on everything.
    const attachTotal = attached.get(p.attachDishId)?.checks ?? 0
    const profit = p.revenue - p.cost
    const lift = liftFor(p.together, base, attachTotal, serverChecks)
    return {
      key,
      baseDishId: p.baseDishId,
      baseName: p.baseName,
      attachDishId: p.attachDishId,
      attachName: p.attachName,
      attachGroup: p.attachGroup,
      baseBills: base,
      together: p.together,
      attachRate: base > 0 ? round1((p.together / base) * 100) : 0,
      attachBills: attachTotal,
      lift: lift === null ? null : Math.round(lift * 10) / 10,
      qty: p.qty,
      revenue: p.revenue,
      cost: p.cost,
      profit,
      margin: p.revenue > 0 ? round1((profit / p.revenue) * 100) : 0,
      confidence: confidenceFor(base),
    }
  })

  const pairings = allPairings
    .filter((p) => p.baseBills >= PAIRING_MIN_BASE_BILLS && p.together >= PAIRING_MIN_TOGETHER)
    .sort((a, b) => b.profit - a.profit)

  // Opportunity: for each pairing, the best rate any one waiter has actually
  // reached on it, and what closing that gap across every base bill is worth in
  // gross profit. Benchmarking on your own floor means no invented targets.
  const opportunities: UpsellOpportunity[] = []
  for (const pairing of pairings) {
    let bestKey: string | null = null
    let bestRate = 0
    let bestBills = 0
    for (const [serverKey] of byServer) {
      const served = serverBaseBills.get(`${serverKey} ${pairing.baseDishId}`) ?? 0
      if (served < BENCHMARK_MIN_WAITER_BILLS) continue
      const both = serverPairBills.get(`${serverKey} ${pairing.key}`) ?? 0
      const rate = (both / served) * 100
      if (rate > bestRate) { bestRate = rate; bestBills = served; bestKey = serverKey }
    }
    if (!bestKey) continue
    const gapPoints = round1(bestRate - pairing.attachRate)
    if (gapPoints <= 0) continue
    const profitPerAttach = pairing.together > 0 ? pairing.profit / pairing.together : 0
    opportunities.push({
      key: pairing.key,
      baseName: pairing.baseName,
      attachName: pairing.attachName,
      baseBills: pairing.baseBills,
      together: pairing.together,
      houseRate: pairing.attachRate,
      bestServerName: serverNames.get(bestKey) ?? bestKey,
      bestServerRate: round1(bestRate),
      bestServerBills: bestBills,
      gapPoints,
      missedProfit: Math.round((gapPoints / 100) * pairing.baseBills * profitPerAttach),
    })
  }
  opportunities.sort((a, b) => b.missedProfit - a.missedProfit)

  // The headline covers only the opportunities actually shown. Summing every
  // pairing would pile up overlapping gaps on the same bills and read as a far
  // bigger prize than anyone could act on.
  const opportunity = opportunities
    .slice(0, OPPORTUNITY_LIMIT)
    .reduce((sum, o) => sum + o.missedProfit, 0)

  const topServer = rows.find((row) => row.ranked) ?? null

  return {
    summary: {
      bills: finalizedHouse.checks,
      upsellRevenue: finalizedHouse.upsellRevenue,
      upsellCost: finalizedHouse.upsellCost,
      upsellProfit: finalizedHouse.upsellProfit,
      upsellMargin: finalizedHouse.upsellMargin,
      profitPerBill: finalizedHouse.profitPerCheck,
      opportunity,
      topServerName: topServer?.serverName ?? null,
      topServerRate: topServer?.addonRate ?? null,
    },
    rows: rows.map(stripInternal),
    house: stripInternal(finalizedHouse),
    pairings,
    opportunities,
    attachedItems: Array.from(attached.values()).sort((a, b) => b.profit - a.profit),
    hourly,
    meta: {
      totalChecks: checks.length,
      serverChecks,
      selfOrderChecks,
      checksWithoutServer,
      coveredChecks,
      uncategorizedItems,
      uncostedAttachLines,
      attachLines,
      attachLinesCosted,
      pairingsTotal: allPairings.filter((p) => p.together >= PAIRING_MIN_TOGETHER).length,
      hourFrom: windowActive ? hourFrom : null,
      hourTo: windowActive ? hourTo : null,
      checksOutsideWindow,
    },
  }
}
