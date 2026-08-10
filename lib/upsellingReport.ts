// Upselling report — how well each server grows the bill.
//
// The unit of analysis is the WHOLE CHECK, restaurant-wide, never a station's
// slice of it. A waiter who sells a burger (Grill) and a soda (Bar) made one
// upsell decision on one bill; scoping to Grill would show that check as
// "no drink attached" and report the opposite of what happened. This is the
// one report that deliberately ignores the per-station attribution used by
// branch-summary and dish-profitability.

export type UpsellGroup = 'food' | 'drink' | 'addon' | 'unknown'

export type UpsellLineItem = {
  dishId: string
  dishName: string
  category: string | null
  qty: number
  dishPrice: number
}

export type UpsellCheck = {
  orderId: string
  staffId: string | null
  staffName: string | null
  createdByName: string | null
  totalAmount: number
  guestCount: number | null
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
  upsellRevenueShare: number
  covers: number
  coveredChecks: number
  apc: number | null
}

export type UpsellAttachedItem = {
  dishId: string
  dishName: string
  category: string | null
  group: UpsellGroup
  qty: number
  checks: number
  revenue: number
}

export type UpsellReport = {
  rows: UpsellServerRow[]
  house: UpsellServerRow
  attachedItems: UpsellAttachedItem[]
  meta: {
    totalChecks: number
    serverChecks: number
    selfOrderChecks: number
    checksWithoutServer: number
    coveredChecks: number
    uncategorizedItems: number
  }
}

// Guests ordering for themselves at the table via the QR menu. There is no
// dedicated flag on the order — the submit route stamps the name and nothing
// else (app/api/order/[restaurantId]/submit/route.ts), so the name prefix is
// the only signal available. These bills must stay out of the server ranking
// entirely: nobody was there to suggest a dessert, so scoring them as a missed
// upsell would punish staff for sales they never attended.
//
// A waiter confirming a QR order appends "· confirmed by <name>" but keeps the
// guest prefix, and that still isn't an upsell — the guest picked the items.
export function isSelfOrder(check: Pick<UpsellCheck, 'createdByName'>): boolean {
  const name = (check.createdByName ?? '').trim()
  return name === 'Guest QR Order' || name.startsWith('Guest - ')
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

export function classifyCategory(raw: string | null | undefined): UpsellGroup {
  const category = normalizeCategory(raw)
  if (!category) return 'unknown'
  if (ADDON_CATEGORIES.has(category)) return 'addon'
  if (DRINK_CATEGORIES.has(category)) return 'drink'
  // Anything else on the menu is something a guest came in to eat.
  return 'food'
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

function emptyRow(serverKey: string, serverName: string, terminalAccount: string | null): UpsellServerRow {
  return {
    serverKey, serverName, terminalAccount,
    checks: 0, checksWithItems: 0, revenue: 0, avgCheck: 0,
    items: 0, itemsPerCheck: 0,
    addonChecks: 0, addonRate: null,
    foodChecks: 0, drinkAttachChecks: 0, drinkAttachRate: null,
    upsellRevenue: 0, upsellRevenueShare: 0,
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
  row.upsellRevenueShare = row.revenue > 0 ? round1((row.upsellRevenue / row.revenue) * 100) : 0
  row.apc = row.covers > 0 ? Math.round(row.coveredRevenue__ / row.covers) : null
  return row
}

export function buildUpsellingReport(checks: UpsellCheck[]): UpsellReport {
  const byServer = new Map<string, InternalRow>()
  const house: InternalRow = { ...emptyRow('__house__', 'House average', null), coveredRevenue__: 0 }
  const attached = new Map<string, UpsellAttachedItem>()

  let checksWithoutServer = 0
  let coveredChecks = 0
  let uncategorizedItems = 0
  let selfOrderChecks = 0
  let serverChecks = 0

  for (const check of checks) {
    // A guest ordering for themselves on the QR menu is not a server's bill.
    // Counted for context, then dropped before any rate is computed.
    if (isSelfOrder(check)) {
      selfOrderChecks++
      continue
    }
    serverChecks++

    const { key, name } = serverKeyFor(check)
    if (key === '__unattributed__') checksWithoutServer++

    let row = byServer.get(key)
    if (!row) {
      row = { ...emptyRow(key, name, check.staffName ?? null), coveredRevenue__: 0 }
      byServer.set(key, row)
    }
    // Which screen they were ringing up on, for context only. First one seen
    // wins; a waiter who moves between terminals is still one row.
    if (!row.terminalAccount && check.staffName) row.terminalAccount = check.staffName

    const revenue = Number(check.totalAmount ?? 0)
    let hasFood = false
    let hasDrink = false
    let hasAddon = false
    let lineCount = 0
    let upsellRevenue = 0

    for (const item of check.items) {
      const qty = Number(item.qty ?? 0)
      const lineRevenue = qty * Number(item.dishPrice ?? 0)
      const group = classifyCategory(item.category)
      lineCount += qty
      if (group === 'food') hasFood = true
      if (group === 'drink') { hasDrink = true; upsellRevenue += lineRevenue }
      if (group === 'addon') { hasAddon = true; upsellRevenue += lineRevenue }
      if (group === 'unknown') uncategorizedItems++

      if (group === 'addon' || group === 'drink') {
        const existing = attached.get(item.dishId)
        if (existing) {
          existing.qty += qty
          existing.checks += 1
          existing.revenue += lineRevenue
        } else {
          attached.set(item.dishId, {
            dishId: item.dishId,
            dishName: item.dishName,
            category: item.category,
            group,
            qty,
            checks: 1,
            revenue: lineRevenue,
          })
        }
      }
    }

    for (const target of [row, house]) {
      target.checks += 1
      if (check.items.length > 0) target.checksWithItems += 1
      target.revenue += revenue
      target.items += lineCount
      target.upsellRevenue += upsellRevenue
      if (hasAddon) target.addonChecks += 1
      if (hasFood) {
        target.foodChecks += 1
        if (hasDrink) target.drinkAttachChecks += 1
      }
      // Guest counts landed on 2026-08-09 and are null on everything before
      // that. Averaging revenue that has no guest count against the guests that
      // do roughly doubles the figure and still looks believable, so orders
      // without a count stay out of both sides — same rule as the dashboard APC.
      if ((check.guestCount ?? 0) > 0) {
        target.covers += check.guestCount as number
        target.coveredChecks += 1
        target.coveredRevenue__ += revenue
      }
    }
    if ((check.guestCount ?? 0) > 0) coveredChecks++
  }

  // Best attach rate first. Servers whose bills carried no items at all have no
  // rate to rank on and sort to the bottom rather than tying with a genuine 0%.
  const rows = Array.from(byServer.values())
    .map(finalize)
    .sort((a, b) => (b.addonRate ?? -1) - (a.addonRate ?? -1) || b.revenue - a.revenue)

  const attachedItems = Array.from(attached.values()).sort((a, b) => b.qty - a.qty)

  return {
    rows: rows.map(stripInternal),
    house: stripInternal(finalize(house)),
    attachedItems,
    meta: {
      totalChecks: checks.length,
      serverChecks,
      selfOrderChecks,
      checksWithoutServer,
      coveredChecks,
      uncategorizedItems,
    },
  }
}

function stripInternal(row: InternalRow): UpsellServerRow {
  const { coveredRevenue__: _unused, ...rest } = row
  return rest
}
