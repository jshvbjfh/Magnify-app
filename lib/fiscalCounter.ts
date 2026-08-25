import { Prisma, type PrismaClient } from '@prisma/client'

type PrismaDb = PrismaClient | Prisma.TransactionClient

/**
 * RRA receipt types.
 *
 * Each carries its own gap-free sequence per outlet — a refund is not the next
 * sale, and numbering them together would put gaps in both.
 */
export const FISCAL_RECEIPT_TYPES = {
  /** Normal sale. The ordinary receipt a paying guest is handed. */
  NORMAL_SALE: 'NS',
  /** Refund. Must reference the sale it reverses. */
  REFUND: 'NR',
  /** Copy of a receipt already issued. Prints as a copy, never as an original. */
  COPY: 'CS',
  /** Training mode. Not a real sale. */
  TRAINING: 'TS',
  /** Proforma — a bill preview, before the guest has paid. */
  PROFORMA: 'PS',
} as const

export type FiscalReceiptType = (typeof FISCAL_RECEIPT_TYPES)[keyof typeof FISCAL_RECEIPT_TYPES]

/**
 * The reserved key for the second, all-types counter.
 *
 * The spec (§7.24.4) prints TWO numbers on every receipt, as "A/B RT" — e.g.
 * "RECEIPT NUMBER: 168/258 NS". 168 counts receipts of that type; 258 counts
 * every receipt the outlet has issued of any type. So a sale advances both its
 * own sequence and the shared one.
 *
 * Held in the same table as the per-type rows so both are claimed by the same
 * atomic increment, in the same transaction. Deliberately not a valid receipt
 * type code, so it can never collide with NS/NR/CS/TS/PS.
 */
const ALL_TYPES_KEY = '*'

function isRecordNotFound(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025'
}

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

async function claimOne(
  db: PrismaDb,
  params: { restaurantId: string; branchId: string; receiptType: string },
): Promise<number> {
  const where = {
    branchId_receiptType: { branchId: params.branchId, receiptType: params.receiptType },
  }

  try {
    const claimed = await db.fiscalCounter.update({
      where,
      data: { nextValue: { increment: 1 } },
      select: { nextValue: true },
    })
    // nextValue now points at the NEXT one, so the number just claimed is the
    // value before the increment.
    return claimed.nextValue - 1
  } catch (error) {
    if (!isRecordNotFound(error)) throw error
  }

  // First receipt of this type at this outlet. Created already pointing at 2,
  // so the row is never observable in a state where 1 has not been handed out.
  try {
    await db.fiscalCounter.create({
      data: {
        restaurantId: params.restaurantId,
        branchId: params.branchId,
        receiptType: params.receiptType,
        nextValue: 2,
      },
    })
    return 1
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
  }

  // Lost the race to create it. Whoever won took 1; claim normally.
  const claimed = await db.fiscalCounter.update({
    where,
    data: { nextValue: { increment: 1 } },
    select: { nextValue: true },
  })

  return claimed.nextValue - 1
}

/**
 * Claims the next fiscal receipt numbers for an outlet, atomically.
 *
 * Returns BOTH numbers the receipt has to print (§7.24.4): the counter for this
 * receipt type, and the counter across all types. They appear on the receipt as
 * "RECEIPT NUMBER: 168/258 NS".
 *
 * MUST be called inside the settlement transaction. A number claimed and then
 * abandoned by a rollback is a gap in the sequence, and §7.3 requires
 * consecutive numbering "in order to guarantee the completeness and the
 * inalterability of the journal records" — so the claim has to succeed or fail
 * together with the sale it belongs to.
 *
 * The atomicity is the database's, not ours: `increment` compiles to
 * `SET nextValue = nextValue + 1 ... RETURNING`, which serialises against any
 * concurrent claim on the same row under both Postgres and SQLite. Two tills
 * settling in the same instant get consecutive numbers, never the same one.
 * Reading the row and writing back would not hold — that is precisely the bug
 * in the order-number generator this replaces.
 *
 * Per §7.3 the sequences restart at 1 only on a total reset of the system.
 * Nothing here resets them, and nothing should: a counter that restarted daily
 * would repeat last week's numbers within the month.
 */
export async function claimFiscalReceiptNumber(
  db: PrismaDb,
  params: { restaurantId: string; branchId: string; receiptType: FiscalReceiptType },
): Promise<{ typeNumber: number; totalNumber: number }> {
  // Order matters only for deadlock avoidance: every caller takes the type row
  // before the shared one, so two concurrent claims can never hold the two rows
  // in opposite orders and wait on each other.
  const typeNumber = await claimOne(db, params)
  const totalNumber = await claimOne(db, { ...params, receiptType: ALL_TYPES_KEY })

  return { typeNumber, totalNumber }
}

/** Formats the pair as the receipt prints it: "168/258 NS". */
export function formatReceiptNumber(
  numbers: { typeNumber: number; totalNumber: number },
  receiptType: FiscalReceiptType,
) {
  return `${numbers.typeNumber}/${numbers.totalNumber} ${receiptType}`
}

/**
 * What the sequences would hand out next, without claiming them.
 *
 * For settings screens and audits only. Never settle against this — between
 * reading it and using it, another till may have taken it.
 */
export async function peekFiscalReceiptNumber(
  db: PrismaDb,
  params: { branchId: string; receiptType: FiscalReceiptType },
): Promise<{ typeNumber: number; totalNumber: number }> {
  const rows = await db.fiscalCounter.findMany({
    where: {
      branchId: params.branchId,
      receiptType: { in: [params.receiptType, ALL_TYPES_KEY] },
    },
    select: { receiptType: true, nextValue: true },
  })

  const valueFor = (receiptType: string) =>
    rows.find((row) => row.receiptType === receiptType)?.nextValue ?? 1

  return { typeNumber: valueFor(params.receiptType), totalNumber: valueFor(ALL_TYPES_KEY) }
}
