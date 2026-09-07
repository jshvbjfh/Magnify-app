import { NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { getRestaurantContextFromSession } from '@/lib/restaurantAccess'
import { buildAuditSnapshot, type AuditCounterState } from '@/lib/fiscalAudit'
import { MAGNIFY_VERSION } from '@/lib/fiscalContext'
import { isFiscalBuild } from '@/lib/fiscalMode'
import { RRA_TAX_CATEGORIES } from '@/lib/restaurantVat'

export const dynamic = 'force-dynamic'

// GET — the audit interface (§7.26).
//
//   "provide to competent auditors an interface for audit purposes, including
//    an overview of software settings and database"
//
// ── Why this route does NOT use loadFiscalOutlet ────────────────────────────
//
// Every other fiscal route refuses to run when the outlet's RRA identity is
// incomplete. This one must do the opposite. An auditor arriving at a till that
// was never registered properly needs to SEE that — an error page saying
// "missing MRC" tells them less than a snapshot whose missingConfiguration
// names it, beside the records the till has been writing regardless.
//
// So the configuration is read raw, and the gaps are reported as findings.
// buildAuditSnapshot masks the controller address; the TIN and MRC stay in full
// because they are printed on every receipt already.
export async function GET() {
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const context = getRestaurantContextFromSession(session.user as Record<string, unknown>)
  const restaurantId = context?.restaurantId ?? null
  const branchId = context?.branchId ?? null
  if (!restaurantId || !branchId) {
    return NextResponse.json({ error: 'No outlet selected' }, { status: 400 })
  }

  const [restaurant, branch, byType, pending, failed, cashMovements, registeredItems, bounds, counters] =
    await Promise.all([
      prisma.restaurant.findUnique({ where: { id: restaurantId }, select: { name: true, tin: true } }),
      prisma.branch.findUnique({
        where: { id: branchId },
        select: { name: true, address: true, billHeader: true, rraBranchCode: true, sdcId: true, mrc: true, vsdcUrl: true },
      }),
      prisma.fiscalReceipt.groupBy({
        by: ['receiptType'],
        where: { branchId },
        _count: { _all: true },
      }),
      prisma.fiscalReceipt.count({ where: { branchId, status: 'PENDING' } }),
      prisma.fiscalReceipt.count({ where: { branchId, status: 'FAILED' } }),
      prisma.cashMovement.count({ where: { branchId } }),
      // §7.30 and API §4.17 — the goods and services this outlet can sell.
      prisma.dish.count({ where: { branchId, isActive: true } }),
      // The period the records cover, so an auditor sees the span at a glance
      // without paging through receipts.
      Promise.all([
        prisma.fiscalReceipt.findFirst({
          where: { branchId },
          orderBy: { businessDate: 'asc' },
          select: { businessDate: true },
        }),
        prisma.fiscalReceipt.findFirst({
          where: { branchId },
          orderBy: { businessDate: 'desc' },
          select: { businessDate: true },
        }),
      ]),
      prisma.fiscalCounter.findMany({
        where: { branchId },
        select: { receiptType: true, nextValue: true },
        orderBy: { receiptType: 'asc' },
      }),
    ])

  if (!restaurant || !branch) {
    return NextResponse.json({ error: 'This outlet is not set up' }, { status: 404 })
  }

  const receiptsByType: Record<string, number> = {}
  let fiscalReceipts = 0
  for (const row of byType) {
    receiptsByType[row.receiptType] = row._count._all
    fiscalReceipts += row._count._all
  }

  const [first, last] = bounds

  const snapshot = buildAuditSnapshot({
    generatedAt: new Date(),
    settings: {
      softwareName: 'Magnify',
      softwareVersion: MAGNIFY_VERSION,
      fiscalBuild: isFiscalBuild(),
      tin: restaurant.tin,
      mrc: branch.mrc,
      sdcId: branch.sdcId,
      rraBranchCode: branch.rraBranchCode,
      vsdcUrl: branch.vsdcUrl,
      tradeName: branch.billHeader?.trim() || branch.name?.trim() || restaurant.name,
      address: branch.address,
      // §7.22 requires every programmed rate to be visible. These are read from
      // the one table the tax arithmetic itself uses, so the screen cannot show
      // a rate the till is not applying.
      taxRates: Object.entries(RRA_TAX_CATEGORIES).map(([category, value]) => ({
        category: `${category} — ${value.label}`,
        ratePercent: value.rate * 100,
      })),
    },
    counts: {
      fiscalReceipts,
      receiptsByType,
      pendingTransmission: pending,
      failedTransmission: failed,
      cashMovements,
      registeredItems,
      firstReceiptAt: first?.businessDate ?? null,
      lastReceiptAt: last?.businessDate ?? null,
    },
    counters: counters as AuditCounterState,
  })

  return NextResponse.json(snapshot)
}
