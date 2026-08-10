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

export type UpsellConfidence = 'high' | 'medium' | 'low'

export type UpsellLineItem = {
  dishId: string
  dishName: string
  category: string | null
  qty: number
  dishPrice: number
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
  qty: number
  revenue: number
  cost: number
  profit: number
  margin: number
  confidence: UpsellConfidence
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
  meta: {
    totalChecks: number
    serverChecks: number
    selfOrderChecks: number
    checksWithoutServer: number
    coveredChecks: number
    uncategorizedItems: number
    uncostedAttachLines: number
    pairingsTotal: number
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

export function classifyCategory(raw: string | null | undefined): UpsellGroup {
  const category = normalizeCategory(raw)
  if (!category) return 'unknown'
  if (ADDON_CATEGORIES.has(category)) return 'addon'
  if (DRINK_CATEGORIES.has(category)) return 'drink'
  // Anything else on the menu is something a guest came in to eat.
  return 'food'
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

export function buildUpsellingReport(checks: UpsellCheck[]): UpsellReport {
  const byServer = new Map<string, InternalRow>()
  const house: InternalRow = { ...emptyRow('__house__', 'House average', null), coveredRevenue__: 0 }
  const attached = new Map<string, UpsellAttachedItem>()

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
    serverNames.set(key, name)

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
    let upsellCost = 0

    // Deduplicated per bill: a dish ordered twice on one check is still one
    // opportunity to attach something, not two.
    const foodOnCheck = new Map<string, string>()
    const attachOnCheck = new Map<string, { name: string; group: 'addon' | 'drink'; qty: number; revenue: number; cost: number }>()

    for (const item of check.items) {
      const qty = Number(item.qty ?? 0)
      const lineRevenue = qty * Number(item.dishPrice ?? 0)
      const group = classifyCategory(item.category)
      lineCount += qty
      if (group === 'food') { hasFood = true; foodOnCheck.set(item.dishId, item.dishName) }
      if (group === 'unknown') uncategorizedItems++

      if (group === 'drink' || group === 'addon') {
        if (group === 'drink') hasDrink = true
        if (group === 'addon') hasAddon = true
        const cost = item.foodCost
        if (cost === null || cost === undefined) uncostedAttachLines++
        const lineCost = Number(cost ?? 0)
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

        const existing = attached.get(item.dishId)
        if (existing) {
          existing.qty += qty
          existing.checks += 1
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
      }
    }

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

    for (const target of [row, house]) {
      target.checks += 1
      if (check.items.length > 0) target.checksWithItems += 1
      target.revenue += revenue
      target.items += lineCount
      target.upsellRevenue += upsellRevenue
      target.upsellCost += upsellCost
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

  const finalizedHouse = finalize(house)

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
    const profit = p.revenue - p.cost
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
    meta: {
      totalChecks: checks.length,
      serverChecks,
      selfOrderChecks,
      checksWithoutServer,
      coveredChecks,
      uncategorizedItems,
      uncostedAttachLines,
      pairingsTotal: allPairings.filter((p) => p.together >= PAIRING_MIN_TOGETHER).length,
    },
  }
}
