// Issuing the fiscal receipt when a bill is settled.
//
// This is the act §7.14 calls journalling: the fiscal_receipts row IS the
// electronic journal, written as the receipt is created rather than afterwards.
//
// ── Why it lives here and not in restaurantOrderPayment ─────────────────────
//
// The payment finalizer is the code every till in Rwanda already runs to close
// a bill. Adding a hundred lines of fiscal logic to it would put that logic in
// the path of venues that have nothing to do with RRA. So the finalizer makes
// ONE guarded call, and everything fiscal is behind it.
//
// ── What a non-fiscal build does ────────────────────────────────────────────
//
// Nothing. isFiscalBuild() is false, this returns null immediately, and not a
// single query runs. High 5ive and Sirocco settle exactly as they did before.
//
// ── What a fiscal build does when it cannot comply ──────────────────────────
//
// It throws, and the settlement transaction rolls back. That is the whole point
// of the clause: a certified system that cannot issue a receipt must refuse the
// sale rather than take the money quietly. Every refusal here is a sale that
// did not happen, not a sale that happened unrecorded.

import type { Prisma, PrismaClient } from '@prisma/client'

import { isFiscalBuild } from '@/lib/fiscalMode'
import { loadFiscalOutlet } from '@/lib/fiscalContext'
import { claimFiscalReceiptNumber, FISCAL_RECEIPT_TYPES } from '@/lib/fiscalCounter'
import { calculateRestaurantOrderTotals, summarizeTaxByCategory } from '@/lib/restaurantOrders'
import { toVsdcPaymentMethod } from '@/lib/vsdc/salesPayload'
import { checkFiscalStock, describeStockRefusal, type StockGuardLine } from '@/lib/fiscalStockGuard'
import { availabilityByDish, type RecipeLine } from '@/lib/fiscalStockAvailability'
import { getRestaurantSharedStock } from '@/lib/inventoryConsumption'
import { round2, type RraTaxCategory } from '@/lib/restaurantVat'

type PrismaDb = PrismaClient | Prisma.TransactionClient

/** Raised when a fiscal build may not issue the receipt this sale requires. */
export class FiscalRefusalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FiscalRefusalError'
  }
}

export type SettlementLine = {
  dishId: string | null
  dishName: string
  dishPrice: number
  qty: number
  discountPercent?: number | null
}

/**
 * Writes the fiscal receipt for a settled bill.
 *
 * MUST be called inside the settlement transaction. The receipt number is
 * claimed from a counter that never goes backwards, so a claim that survived a
 * rolled-back sale would leave a gap — and §7.3 requires the sequence to be
 * consecutive precisely so that a gap means something.
 *
 * Returns null on a non-fiscal build, and on a comped bill: nothing was
 * collected and nothing is declared.
 */
export async function issueFiscalReceiptForSettlement(
  db: PrismaDb,
  params: {
    restaurantId: string
    branchId: string
    orderId: string
    orderNumber: string
    paymentMethod: string
    businessDate: Date
    /** True for a comp. No money changed hands, so no sale is declared. */
    comped?: boolean
    /**
     * The GUEST's TIN, where the buyer is a business reclaiming the VAT.
     *
     * Optional, and absent on most bills. Anything that is not nine digits is
     * dropped rather than declared: a partial or mistyped TIN would attribute
     * the purchase to the wrong taxpayer, or to none, which is worse than
     * declaring it against an unidentified buyer as RRA's nullable field
     * already allows.
     */
    customerTin?: string | null
    lines: SettlementLine[]
  },
) {
  if (!isFiscalBuild()) return null
  if (params.comped) return null
  if (params.lines.length === 0) return null

  // ── The outlet must be registered ────────────────────────────────────────
  const outletResult = await loadFiscalOutlet(db, params.restaurantId, params.branchId)
  if (!outletResult.ok) {
    // Not "trade without VAT" — refuse. See lib/fiscalMode: those two outcomes
    // look alike from the code and are opposite in law.
    throw new FiscalRefusalError(outletResult.gap)
  }

  // ── §7.30: no receipt for goods that are not there ───────────────────────
  await assertStockAvailable(db, params)

  // The tax bracket lives on the dish, and it has to be read. Defaulting every
  // line to standard-rated would declare a bill of exempt food as taxable and
  // put the brackets on the receipt in the wrong rows — over-declaring here,
  // under-declaring the moment a venue classifies anything as exempt.
  const dishIds = [...new Set(params.lines.map((line) => line.dishId).filter((id): id is string => Boolean(id)))]
  const taxCategories = new Map<string, string | null>(
    dishIds.length
      ? (
          await db.dish.findMany({
            where: { id: { in: dishIds }, restaurantId: params.restaurantId },
            select: { id: true, taxCategory: true },
          })
        ).map((dish) => [dish.id, dish.taxCategory])
      : [],
  )

  // ── §7.3: the number, claimed atomically inside this transaction ─────────
  const numbers = await claimFiscalReceiptNumber(db, {
    restaurantId: params.restaurantId,
    branchId: params.branchId,
    receiptType: FISCAL_RECEIPT_TYPES.NORMAL_SALE,
  })

  const totals = calculateRestaurantOrderTotals(
    params.lines.map((line) => ({
      dishPrice: Number(line.dishPrice),
      qty: Number(line.qty),
      discountPercent: line.discountPercent,
      taxCategory: line.dishId ? taxCategories.get(line.dishId) ?? null : null,
    })),
    { fiscalMode: true },
  )
  const brackets = summarizeTaxByCategory(totals.taxLines)
  const byCategory = (category: RraTaxCategory) => brackets.find((row) => row.category === category)

  const totalTaxAmount = round2(brackets.reduce((sum, row) => sum + row.taxAmount, 0))
  const discountTotal = round2(
    params.lines.reduce((sum, line) => {
      const pct = Number(line.discountPercent ?? 0)
      if (!(pct > 0 && pct <= 100)) return sum
      return sum + Number(line.dishPrice) * Number(line.qty) * (pct / 100)
    }, 0),
  )

  // ── §7.14: the journal entry, written as the receipt is created ──────────
  //
  // PENDING, and deliberately so. §10 forbids printing before the controller
  // answers, so this row records that a receipt is owed — it does not assert
  // that one was handed over. It becomes SENT only when the VSDC replies.
  return db.fiscalReceipt.create({
    data: {
      restaurantId: params.restaurantId,
      branchId: params.branchId,
      orderId: params.orderId,
      receiptType: FISCAL_RECEIPT_TYPES.NORMAL_SALE,
      invoiceNumber: numbers.totalNumber,
      // Nine digits or nothing — see the note on the parameter.
      customerTin: /^\d{9}$/.test(String(params.customerTin ?? '').trim())
        ? String(params.customerTin).trim()
        : null,
      paymentTypeCode: toVsdcPaymentMethod(params.paymentMethod),
      totalAmount: totals.totalAmount,
      totalTaxableAmount: round2(totals.totalAmount - totalTaxAmount),
      totalTaxAmount,
      taxableAmtA: byCategory('A')?.taxableAmount ?? 0,
      taxableAmtB: byCategory('B')?.taxableAmount ?? 0,
      taxableAmtC: byCategory('C')?.taxableAmount ?? 0,
      taxableAmtD: byCategory('D')?.taxableAmount ?? 0,
      taxAmtA: byCategory('A')?.taxAmount ?? 0,
      taxAmtB: byCategory('B')?.taxAmount ?? 0,
      taxAmtC: byCategory('C')?.taxAmount ?? 0,
      taxAmtD: byCategory('D')?.taxAmount ?? 0,
      itemCount: params.lines.length,
      discountTotal,
      status: 'PENDING',
      businessDate: params.businessDate,
    },
  })
}

/**
 * §7.30 — refuses the sale when a GOODS line has less stock than it asks for.
 *
 * Runs again here even though the till already asked, because stock can go in
 * the seconds between the waiter pressing settle and this transaction opening.
 * This is the check that binds; the till's is the courtesy.
 */
async function assertStockAvailable(
  db: PrismaDb,
  params: { restaurantId: string; branchId: string; lines: SettlementLine[] },
) {
  const dishIds = [...new Set(params.lines.map((line) => line.dishId).filter((id): id is string => Boolean(id)))]
  if (dishIds.length === 0) return

  const dishes = await db.dish.findMany({
    where: { id: { in: dishIds }, restaurantId: params.restaurantId, deletedAt: null },
    select: {
      id: true, name: true, itemCode: true, itemType: true, preparedPortions: true,
      ingredients: { select: { inventoryItemId: true, quantityRequired: true } },
    },
  })

  // Only GOODS can be refused, so anything else need not be priced up at all.
  const goods = dishes.filter((dish) => String(dish.itemType ?? '').toUpperCase() === 'GOODS')
  if (goods.length === 0) return

  const recipes = new Map<string, RecipeLine[]>(
    goods.map((dish) => [dish.id, dish.ingredients.map((row) => ({
      inventoryItemId: row.inventoryItemId,
      quantityRequired: Number(row.quantityRequired ?? 0),
    }))]),
  )

  const itemIds = [...new Set(goods.flatMap((dish) => dish.ingredients.map((row) => row.inventoryItemId)))]
  const sharedStock = await getRestaurantSharedStock(db, params.restaurantId)
  const stockRows = itemIds.length
    ? await db.inventoryItem.findMany({
        where: {
          id: { in: itemIds },
          restaurantId: params.restaurantId,
          deletedAt: null,
          ...(sharedStock ? {} : { branchId: params.branchId }),
        },
        select: { id: true, quantity: true },
      })
    : []

  const onHand = new Map(stockRows.map((row) => [row.id, Number(row.quantity ?? 0)]))
  const available = availabilityByDish(goods, recipes, onHand)

  const wantedByDish = new Map<string, number>()
  for (const line of params.lines) {
    if (!line.dishId) continue
    wantedByDish.set(line.dishId, (wantedByDish.get(line.dishId) ?? 0) + Number(line.qty))
  }

  const guardLines: StockGuardLine[] = goods.map((dish) => ({
    name: dish.name,
    itemCode: dish.itemCode,
    qty: wantedByDish.get(dish.id) ?? 0,
    itemType: dish.itemType,
    available: available.get(dish.id),
  }))

  const refusals = checkFiscalStock(guardLines)
  if (refusals.length > 0) {
    throw new FiscalRefusalError(describeStockRefusal(refusals) ?? 'Not enough stock to issue this receipt')
  }
}
