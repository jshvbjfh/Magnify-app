import { Prisma, type PrismaClient } from '@prisma/client'
import {
  calculateGrossFromNet,
  calculateVatFromNet,
  normalizeTaxCategory,
  round2,
  splitTaxInclusive,
  type RraTaxCategory,
} from '@/lib/restaurantVat'
import { enqueueSyncChange } from '@/lib/syncOutbox'

type PrismaDb = PrismaClient | Prisma.TransactionClient

type TotalsInput = Array<{
  dishPrice: number
  qty: number
  discountPercent?: number | null
  // Only read in fiscal mode. Null/absent falls back to the standard rate.
  taxCategory?: string | null
}>

/**
 * Whether this restaurant issues RRA fiscal receipts.
 *
 * Passed in rather than looked up, because the totals are computed in eight
 * places — including two that run inside a settlement transaction — and a
 * database round-trip in each of them to answer one boolean would be paid on
 * every order, forever, at every venue including the ones that will never
 * switch it on.
 */
export type OrderTotalsOptions = { fiscalMode?: boolean }

export type OrderTaxLine = {
  category: RraTaxCategory
  /** What the guest is charged for this line, after any discount. */
  grossAmount: number
  taxableAmount: number
  taxAmount: number
}

export const ACTIVE_RESTAURANT_ORDER_STATUSES = ['PENDING', 'OPEN'] as const

/**
 * The tender written on a comped bill: the guests ate, the table closed, and
 * nothing was collected — the owner's guests, a staff meal, a service recovery.
 *
 * It is a settlement, not a payment. An order carrying it is stored with its
 * totals at zero and the written-off value kept in `compedAmount`, so revenue,
 * average-per-cover and every sales report contribute nothing for it without
 * having to know comps exist. The food still comes off stock, because it really
 * was cooked and eaten.
 *
 * Exported as one constant rather than spelled out at each call site: the string
 * is compared in the push handler, the payment finalizer and the reports, and a
 * typo in any one of them would silently book a comp as income.
 */
export const NO_CHARGE_METHOD = 'Complementary'

/**
 * Every spelling this tender has ever been stored under.
 *
 * 'No Charge' shipped first and is hardcoded into the tills already in the
 * field, which keep sending it until every one of them updates. Dropping it
 * here would not "clean up a legacy name" — it would make those comps stop
 * being recognised as comps, and a comp that is not recognised is booked as
 * revenue that was never collected. Never remove a value from this list.
 */
const NO_CHARGE_ALIASES = [
  NO_CHARGE_METHOD,
  'complementary',  // the current name
  'complimentary',  // the other spelling of the same word
  'compl.', 'compl',
  'No Charge',      // the name it shipped under first
].map((value) => value.toLowerCase())

/** Whether a settlement collected nothing. Trims and ignores case, because the
 *  value arrives from a device and only ever has to mean one thing. */
export function isNoChargeMethod(paymentMethod: string | null | undefined): boolean {
  return NO_CHARGE_ALIASES.includes(String(paymentMethod ?? '').trim().toLowerCase())
}

/**
 * Every stored spelling AND casing, for `where: { paymentMethod: { in: ... } }`
 * filters that cannot call isNoChargeMethod because the matching happens in SQL.
 *
 * Postgres `IN` is case-sensitive, so unlike isNoChargeMethod this list cannot
 * lowercase its way out of the problem — every casing a device might have
 * written has to appear literally. A spelling missing here is a free meal
 * missing from the only report that names free meals, so err on the side of
 * listing too many.
 */
export const NO_CHARGE_METHOD_VALUES = [
  'Complementary', 'complementary', 'COMPLEMENTARY',
  'Complimentary', 'complimentary',
  'compl.', 'Compl.', 'compl', 'Compl',
  'No Charge', 'no charge', 'NO CHARGE',
]

/**
 * What one line is actually worth after its discount — the ONLY definition of
 * that in the app, on purpose.
 *
 * Three separate places used to turn a line into money: the order totals below,
 * the journal entry raised at payment, and DishSale.totalSaleAmount. If any one
 * of them applied a discount the others did not, the till would collect one
 * figure and the books would record another, and nothing would surface it until
 * a reconciliation failed weeks later. They all call this now.
 *
 * A discount outside 0–100, or one that is not a finite number, is treated as no
 * discount at all. Refusing loudly would block a waiter mid-service over a
 * mistyped field; charging full price is the safe direction to fail, because it
 * is visible on the bill immediately and nobody is short-changed.
 */
export function calculateLineNetAmount(item: { dishPrice: number; qty: number; discountPercent?: number | null }) {
  const gross = Number(item.dishPrice) * Number(item.qty)
  if (!Number.isFinite(gross)) return 0
  const raw = Number(item.discountPercent)
  const pct = Number.isFinite(raw) && raw > 0 && raw <= 100 ? raw : 0
  return gross * (1 - pct / 100)
}

/**
 * What an order is worth, in whichever tax regime the restaurant runs.
 *
 * `totalAmount` means the same thing in both modes and is the reason the switch
 * is safe: it is what the guest pays. Turning fiscal mode on does not move it by
 * a franc — the tax is carved OUT of the menu price, not added to it — so the
 * only figures that change are the ones nobody was charging against before.
 *
 * The two modes differ in how they round, deliberately:
 *
 *   off — no rounding at all, exactly as before. A venue that has not been
 *         switched over must produce figures identical to the ones it produced
 *         before any of this existed, and "identical" has to mean bit-for-bit,
 *         not "to the nearest franc". Reports compare historical totals.
 *
 *   on  — every line is rounded to two decimals and the order total is the SUM
 *         OF THE ROUNDED LINES, never a rounded sum of raw values. RRA's receipt
 *         signature covers the line amounts and the totals together, so the two
 *         have to reconcile exactly; rounding the total independently disagrees
 *         with its own lines on roughly one order in fifty.
 */
export function calculateRestaurantOrderTotals(items: TotalsInput, options: OrderTotalsOptions = {}) {
  if (!options.fiscalMode) {
    const subtotalAmount = items.reduce((sum, item) => sum + calculateLineNetAmount(item), 0)
    const vatAmount = calculateVatFromNet(subtotalAmount)
    const totalAmount = calculateGrossFromNet(subtotalAmount)

    return { subtotalAmount, vatAmount, totalAmount, taxLines: [] as OrderTaxLine[] }
  }

  const taxLines: OrderTaxLine[] = items.map((item) => {
    const category = normalizeTaxCategory(item.taxCategory)
    const grossAmount = round2(calculateLineNetAmount(item))
    const { taxableAmount, taxAmount } = splitTaxInclusive(grossAmount, category)

    return { category, grossAmount, taxableAmount, taxAmount }
  })

  const totalAmount = round2(taxLines.reduce((sum, line) => sum + line.grossAmount, 0))
  const vatAmount = round2(taxLines.reduce((sum, line) => sum + line.taxAmount, 0))
  // Derived, not summed: subtotal + vat must equal what the guest paid, and
  // taking the remainder is the only way that holds for every combination of
  // brackets on one bill.
  const subtotalAmount = round2(totalAmount - vatAmount)

  return { subtotalAmount, vatAmount, totalAmount, taxLines }
}

/**
 * The per-bracket breakdown a fiscal receipt prints and the VSDC payload
 * carries: one row per tax category actually present on the bill.
 *
 * Derived from the lines rather than stored on the order. The order already
 * keeps the total tax in `vatAmount`, and a stored-per-bracket copy is a second
 * source of truth that can drift from the lines it claims to summarise — which
 * is the exact failure the journal/DishSale split was rewritten to avoid.
 */
export function summarizeTaxByCategory(taxLines: OrderTaxLine[]) {
  const byCategory = new Map<RraTaxCategory, { category: RraTaxCategory; taxableAmount: number; taxAmount: number; grossAmount: number }>()

  for (const line of taxLines) {
    const row = byCategory.get(line.category)
    if (row) {
      row.taxableAmount = round2(row.taxableAmount + line.taxableAmount)
      row.taxAmount = round2(row.taxAmount + line.taxAmount)
      row.grossAmount = round2(row.grossAmount + line.grossAmount)
    } else {
      byCategory.set(line.category, {
        category: line.category,
        taxableAmount: line.taxableAmount,
        taxAmount: line.taxAmount,
        grossAmount: line.grossAmount,
      })
    }
  }

  return [...byCategory.values()].sort((a, b) => a.category.localeCompare(b.category))
}

export function getRestaurantOrderDisplayStatus(order: { status: string }) {
  if (order.status === 'CANCELED') return 'CANCELED'
  if (order.status === 'PAID') return 'PAID'
  return 'PENDING'
}

export async function generateRestaurantOrderNumber(db: PrismaDb, restaurantId: string, branchId?: string | null) {
  const latest = await db.restaurantOrder.findFirst({
    where: {
      restaurantId,
      ...(branchId ? { branchId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    select: { orderNumber: true },
  })

  const current = latest?.orderNumber ? Number(latest.orderNumber.replace(/[^0-9]/g, '')) || 0 : 0
  return `ORD-${String(current + 1).padStart(6, '0')}`
}

export function isRestaurantOrderNumberConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    && error.code === 'P2002'
    && Array.isArray(error.meta?.target)
    && error.meta.target.includes('orderNumber')
    && (error.meta.target.includes('restaurantId') || error.meta.target.includes('branchId'))
}

export async function syncRestaurantOrderTotals(
  db: PrismaDb,
  orderId: string,
  options: OrderTotalsOptions = {},
) {
  const activeItems = await db.orderItem.findMany({
    where: { orderId, status: 'ACTIVE' },
    // discountPercent is NOT optional here, however tempting it looks.
    //
    // calculateLineNetAmount reads it, and a column that was not selected
    // arrives as undefined — which that function treats as "no discount" by
    // design, because a mistyped percentage must not block a waiter mid-service.
    // Both behaviours are right on their own and catastrophic together: this
    // runs at the top of every settlement, so a discounted bill was rewritten
    // back to full menu price. The guest pays the discounted amount printed on
    // their bill while the order, the revenue and the books record the full one,
    // and nothing surfaces the difference until the till fails to reconcile.
    //
    // taxCategory joins it for the same reason: in fiscal mode an unselected
    // category silently falls back to the standard rate, which is the safe
    // default for an unclassified dish but wrong for a genuinely exempt one.
    select: { dishPrice: true, qty: true, discountPercent: true, taxCategory: true },
  })

  // Only the money goes to the database. calculateRestaurantOrderTotals also
  // returns the per-line tax breakdown, which is derived rather than stored and
  // is not a column on the order.
  const { subtotalAmount, vatAmount, totalAmount } = calculateRestaurantOrderTotals(activeItems, options)

  return db.restaurantOrder.update({
    where: { id: orderId },
    data: { subtotalAmount, vatAmount, totalAmount },
  })
}

export async function enqueueOrderSync(
  db: PrismaDb,
  orderId: string,
  restaurantId: string,
  branchId?: string | null,
  sourceDeviceId?: string | null,
) {
  const order = await db.restaurantOrder.findUnique({
    where: { id: orderId },
    include: { items: true },
  })
  if (!order) return

  if (order.items.length === 0 && order.status !== 'CANCELED') {
    console.warn(`[sync] enqueueOrderSync: order ${orderId} has 0 items (status=${order.status})`)
  }

  await enqueueSyncChange(db, {
    restaurantId,
    branchId: branchId ?? order.branchId ?? null,
    entityType: 'restaurantOrder',
    entityId: orderId,
    operation: 'upsert',
    sourceDeviceId: sourceDeviceId ?? null,
    payload: { ...order, items: order.items },
  })
}

function formatTimelineEventAt(value: Date | string | null) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return null

  return new Intl.DateTimeFormat('en-RW', {
    timeZone: 'Africa/Kigali',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function buildRestaurantOrderTimeline(order: {
  createdAt: Date | string
  createdByName?: string | null
  paidAt: Date | string | null
  canceledAt: Date | string | null
  cancelReason: string | null
}) {
  const createdAtLabel = formatTimelineEventAt(order.createdAt)
  const timeline = [`Pushed by ${order.createdByName || 'Staff'}${createdAtLabel ? ` at ${createdAtLabel}` : ''}`]

  if (order.paidAt) {
    const paidAtLabel = formatTimelineEventAt(order.paidAt)
    timeline.push(`Paid${paidAtLabel ? ` at ${paidAtLabel}` : ''}`)
  }
  if (order.canceledAt) {
    const canceledAtLabel = formatTimelineEventAt(order.canceledAt)
    timeline.push(`Canceled${canceledAtLabel ? ` at ${canceledAtLabel}` : ''}${order.cancelReason ? ` - ${order.cancelReason}` : ''}`)
  }

  return timeline
}
