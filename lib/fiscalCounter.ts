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

function isRecordNotFound(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025'
}

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

/**
 * Claims the next fiscal receipt number for an outlet, atomically.
 *
 * MUST be called inside the settlement transaction. A number claimed and then
 * abandoned by a rollback is a gap in the sequence, and a gap is what RRA
 * audits for — so the claim has to succeed or fail together with the sale it
 * belongs to.
 *
 * The atomicity is the database's, not ours: `increment` compiles to
 * `SET nextValue = nextValue + 1 ... RETURNING`, which serialises against any
 * concurrent claim on the same row under both Postgres and SQLite. Two tills
 * settling in the same instant get consecutive numbers, never the same one.
 * Reading the row and writing back would not hold — that is precisely the bug
 * in the order-number generator this replaces.
 */
export async function claimFiscalReceiptNumber(
  db: PrismaDb,
  params: { restaurantId: string; branchId: string; receiptType: FiscalReceiptType },
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
 * What the sequence would hand out next, without claiming it.
 *
 * For settings screens and audits only. Never settle against this — between
 * reading it and using it, another till may have taken it.
 */
export async function peekFiscalReceiptNumber(
  db: PrismaDb,
  params: { branchId: string; receiptType: FiscalReceiptType },
): Promise<number> {
  const row = await db.fiscalCounter.findUnique({
    where: { branchId_receiptType: { branchId: params.branchId, receiptType: params.receiptType } },
    select: { nextValue: true },
  })

  return row?.nextValue ?? 1
}
