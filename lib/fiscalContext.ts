// The outlet's fiscal identity, loaded once and shared by every fiscal route.
//
// Two things live here, and they are deliberately together.
//
// The first is the identity RRA issued for this outlet — TIN, SDC ID, MRC,
// branch code, controller address. §7.4 requires the MRC on every receipt and
// §18.1.4 requires it on every report, so essentially nothing fiscal can be
// produced without loading it.
//
// The second is the REFUSAL. A fiscal build whose identity is incomplete has
// not been registered yet, and must stop rather than trade — see lib/fiscalMode.
// Putting the loader and the refusal in one function means a route cannot
// accidentally obtain the first without honouring the second: `gap` comes back
// in the same object, and a route that ignores it is visibly ignoring it.
//
// Reads the database. The pure fiscal logic stays in lib/fiscalMode, which this
// calls — nothing here decides anything.

import type { Prisma, PrismaClient } from '@prisma/client'
import { describeFiscalConfigurationGap, isFiscalBuild } from '@/lib/fiscalMode'

type PrismaDb = PrismaClient | Prisma.TransactionClient

/**
 * The software's own designation (§7.7, §18.1.4).
 *
 * Hard-coded rather than read from package.json because the version has to
 * survive bundling — `npm_package_version` is a build-time shell variable and is
 * simply absent at runtime in a packaged Electron app, which would print an
 * empty version on every receipt.
 *
 * lib/__tests__/fiscalContext.test.ts asserts this matches package.json, so the
 * two cannot drift.
 */
export const MAGNIFY_VERSION = '1.1.50'

/** Printed beside the MRC on receipts and reports. */
export const CIS_DESIGNATION = `Magnify ${MAGNIFY_VERSION}`

export type FiscalOutlet = {
  restaurantId: string
  branchId: string
  /** Trade name as it prints on the receipt header (§13.1). */
  tradeName: string
  address: string | null
  tin: string
  sdcId: string
  mrc: string
  rraBranchCode: string
  vsdcUrl: string
  cisDesignation: string
}

export type FiscalOutletResult =
  | { ok: true; outlet: FiscalOutlet; gap: null }
  | { ok: false; outlet: null; gap: string }

/**
 * Load this outlet's fiscal identity, or the one-line reason it cannot trade.
 *
 * On a NON-fiscal build this still returns ok, with whatever identity happens to
 * be stored. That is intentional: the ordinary product must keep working, and a
 * venue outside Rwanda has no TIN to give. Callers that issue receipts are
 * gated by isFiscalBuild() at their own entry point, not here.
 */
export async function loadFiscalOutlet(
  db: PrismaDb,
  restaurantId: string,
  branchId: string,
): Promise<FiscalOutletResult> {
  const [restaurant, branch] = await Promise.all([
    db.restaurant.findUnique({
      where: { id: restaurantId },
      select: { name: true, tin: true },
    }),
    db.branch.findUnique({
      where: { id: branchId },
      select: { name: true, address: true, billHeader: true, rraBranchCode: true, sdcId: true, mrc: true, vsdcUrl: true },
    }),
  ])

  if (!restaurant || !branch) {
    return { ok: false, outlet: null, gap: 'This outlet is not set up' }
  }

  const config = {
    tin: restaurant.tin,
    sdcId: branch.sdcId,
    mrc: branch.mrc,
    rraBranchCode: branch.rraBranchCode,
    vsdcUrl: branch.vsdcUrl,
  }

  const gap = describeFiscalConfigurationGap(config)
  if (gap) return { ok: false, outlet: null, gap }

  return {
    ok: true,
    gap: null,
    outlet: {
      restaurantId,
      branchId,
      // The bill header is what the venue chose to call itself on paper; the
      // branch name is the fallback, and the restaurant name the last resort.
      // A receipt must carry the trade name (§13.1), and the venue's own
      // wording is the closest thing to it that the app holds.
      tradeName: (branch.billHeader?.trim() || branch.name?.trim() || restaurant.name || '').trim(),
      address: branch.address?.trim() || null,
      tin: String(config.tin ?? '').trim(),
      sdcId: String(config.sdcId ?? '').trim(),
      mrc: String(config.mrc ?? '').trim(),
      rraBranchCode: String(config.rraBranchCode ?? '').trim(),
      vsdcUrl: String(config.vsdcUrl ?? '').trim(),
      cisDesignation: CIS_DESIGNATION,
    },
  }
}

/**
 * Whether a fiscal route may run at all.
 *
 * Fiscal endpoints exist in every build so that the code is exercised by tests
 * and reviewable in one place, but on a non-fiscal build they must not pretend
 * to issue anything. Read-only endpoints (the reports, the audit interface) are
 * safe either way and do not call this.
 */
export function fiscalIssuingAllowed(): boolean {
  return isFiscalBuild()
}
