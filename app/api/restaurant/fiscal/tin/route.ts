import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { resolveCancellationApprover } from '@/lib/cancelApproval'
import { isServiceMode } from '@/lib/fiscalMode'
import { buildFiscalExport, exportDigestMatches } from '@/lib/fiscalExport'
import { describeTinChangeRefusal, describeTinResetPlan, isValidTin } from '@/lib/fiscalTinReset'

export const dynamic = 'force-dynamic'

// Changing the taxpayer (§7.2), and the reset it is conditioned by.
//
//   "have reprogrammable TIN under its service mode, for the purpose of
//    ownership transfer, only if the change of TIN is conditioned by the reset
//    which deletes all information saved for previously programmed TIN"
//
// ── The shape of this ───────────────────────────────────────────────────────
//
//   GET   the plan: what would be erased, and the export of everything that
//         would be lost, carrying a digest of itself
//   POST  the change, which will not run without that digest back
//
// The digest is what makes "records were exported" a fact rather than a
// checkbox. It matches only if the caller holds a copy of the records AS THEY
// STAND NOW — an export taken before last week's trading no longer matches, so
// it cannot authorise erasing that week.
//
// Everything below runs only in service mode, which is an environment value on
// the machine rather than anything reachable from the app.

/** Everything held under the current TIN, in the order it will be erased. */
async function gatherFiscalRecords(branchId: string) {
  const [receipts, counters, cashMovements] = await Promise.all([
    prisma.fiscalReceipt.findMany({ where: { branchId }, orderBy: { invoiceNumber: 'asc' } }),
    prisma.fiscalCounter.findMany({
      where: { branchId },
      orderBy: { receiptType: 'asc' },
      select: { receiptType: true, nextValue: true },
    }),
    prisma.cashMovement.findMany({ where: { branchId }, orderBy: { createdAt: 'asc' } }),
  ])
  return { receipts, counters, cashMovements }
}

export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null
  if (!restaurantId || !branchId) return NextResponse.json({ error: 'No outlet selected' }, { status: 400 })

  if (!isServiceMode()) {
    return NextResponse.json({ error: 'The TIN can only be changed in service mode' }, { status: 403 })
  }

  const [restaurant, branch, records] = await Promise.all([
    prisma.restaurant.findUnique({ where: { id: restaurantId }, select: { tin: true } }),
    prisma.branch.findUnique({ where: { id: branchId }, select: { mrc: true } }),
    gatherFiscalRecords(branchId),
  ])

  const exported = buildFiscalExport({
    tin: restaurant?.tin ?? null,
    branchId,
    mrc: branch?.mrc ?? null,
    ...records,
  })

  return NextResponse.json({
    currentTin: restaurant?.tin ?? null,
    serviceMode: true,
    // What a reset would destroy, spelled out rather than summarised — someone
    // transferring ownership should read the list before agreeing to it.
    erases: describeTinResetPlan({
      currentTin: restaurant?.tin ?? null,
      newTin: '',
      inServiceMode: true,
      resetConfirmed: false,
      recordsExported: false,
    }).erases,
    export: exported,
  })
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null
  if (!restaurantId || !branchId) return NextResponse.json({ error: 'No outlet selected' }, { status: 400 })

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const newTin = String(body.newTin ?? '').trim()
  const resetConfirmed = body.resetConfirmed === true
  const exportDigest = body.exportDigest

  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { tin: true },
  })

  // The supervisor is resolved first so their name can be put to the refusal
  // check — an unapproved change must fail for that reason, not for a missing
  // name it never asked for.
  const approver = await resolveCancellationApprover({
    restaurantId,
    branchId,
    pin: String(body.supervisorPin ?? '').trim(),
  })

  // Whether a copy exists is not the caller's word. Recomputed here against the
  // records as they stand, so a stale export cannot authorise the erasure.
  const records = await gatherFiscalRecords(branchId)
  const branch = await prisma.branch.findUnique({ where: { id: branchId }, select: { mrc: true } })
  const current = buildFiscalExport({
    tin: restaurant?.tin ?? null,
    branchId,
    mrc: branch?.mrc ?? null,
    ...records,
  })
  const recordsExported = exportDigestMatches(current.digest, exportDigest)

  const request = {
    currentTin: restaurant?.tin ?? null,
    newTin,
    inServiceMode: isServiceMode(),
    resetConfirmed,
    recordsExported,
    approvedByName: approver?.name ?? null,
  }

  const refusal = describeTinChangeRefusal(request)
  if (refusal) {
    return NextResponse.json(
      {
        error: refusal,
        // So a screen can tell "you sent no digest" from "your copy is out of
        // date", which are different problems with different fixes.
        expectedDigest: isValidTin(newTin) && !recordsExported ? current.digest : undefined,
      },
      { status: exportDigestMatches(current.digest, exportDigest) ? 400 : 409 },
    )
  }

  // One transaction. A reset that erased the receipts and then failed before
  // the counters would leave numbering continuing under a new taxpayer, which
  // is the precise condition §7.2 exists to prevent.
  const erased = await prisma.$transaction(async (tx) => {
    const receipts = await tx.fiscalReceipt.deleteMany({ where: { branchId } })
    const counters = await tx.fiscalCounter.deleteMany({ where: { branchId } })
    const cash = await tx.cashMovement.deleteMany({ where: { branchId } })

    await tx.restaurant.update({ where: { id: restaurantId }, data: { tin: newTin } })

    return { receipts: receipts.count, counters: counters.count, cashMovements: cash.count }
  })

  return NextResponse.json({
    changed: true,
    from: request.currentTin,
    to: newTin,
    approvedByName: request.approvedByName,
    erased,
    // §7.3 — numbering recommences from 1. The counter rows are gone, and
    // lib/fiscalCounter creates them again at 1 on the next sale.
    countersRestartAt: 1,
  })
}
