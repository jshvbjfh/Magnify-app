// The audit interface (§7.26).
//
//   "provide to competent auditors an interface for audit purposes, including
//    an overview of software settings and database"
//
// RRA staff will use this during the technical review, and an auditor may ask
// for it afterwards. It has to show the configuration the system is running
// under and the fiscal records it holds, WITHOUT anyone needing developer
// tools.
//
// PURE: the caller gathers the counts and settings; this assembles and
// redacts them.

import { round2 } from '@/lib/restaurantVat'

export type AuditSettings = {
  softwareName: string
  /** §7.7 — the version must be verifiable by Authority personnel. */
  softwareVersion: string
  fiscalBuild: boolean
  tin?: string | null
  mrc?: string | null
  sdcId?: string | null
  rraBranchCode?: string | null
  vsdcUrl?: string | null
  tradeName?: string | null
  address?: string | null
  /** Tax rates as actually programmed, so an auditor sees what is applied. */
  taxRates: Array<{ category: string; ratePercent: number }>
}

export type AuditCounts = {
  fiscalReceipts: number
  receiptsByType: Record<string, number>
  pendingTransmission: number
  failedTransmission: number
  cashMovements: number
  registeredItems: number
  /** Oldest and newest receipt, so the covered period is visible at a glance. */
  firstReceiptAt?: Date | string | null
  lastReceiptAt?: Date | string | null
}

export type AuditCounterState = Array<{ receiptType: string; nextValue: number }>

/**
 * Masks all but the last four characters.
 *
 * The VSDC URL and credentials are configuration an auditor should see the
 * SHAPE of — that it is set, and which endpoint — without this screen becoming
 * a way to read secrets off someone's till. The TIN and MRC are printed on
 * every receipt, so those stay in full.
 */
function tail(value: string | null | undefined): string | null {
  const text = String(value ?? '').trim()
  if (!text) return null
  if (text.length <= 4) return text
  return `${'•'.repeat(Math.min(8, text.length - 4))}${text.slice(-4)}`
}

/**
 * The audit snapshot.
 *
 * Flags anything an auditor would ask about rather than leaving them to spot
 * it: receipts still queued, receipts that failed to transmit, and fiscal
 * configuration that is missing.
 */
export function buildAuditSnapshot(input: {
  settings: AuditSettings
  counts: AuditCounts
  counters: AuditCounterState
  generatedAt: Date | string
}) {
  const { settings, counts } = input

  const missing: string[] = []
  if (!String(settings.tin ?? '').trim()) missing.push('TIN')
  if (!String(settings.mrc ?? '').trim()) missing.push('MRC')
  if (!String(settings.sdcId ?? '').trim()) missing.push('SDC ID')
  if (!String(settings.rraBranchCode ?? '').trim()) missing.push('branch code')
  if (!String(settings.vsdcUrl ?? '').trim()) missing.push('VSDC address')

  const concerns: string[] = []
  if (counts.failedTransmission > 0) {
    concerns.push(`${counts.failedTransmission} receipt(s) failed to transmit`)
  }
  if (counts.pendingTransmission > 0) {
    concerns.push(`${counts.pendingTransmission} receipt(s) awaiting transmission`)
  }
  if (settings.fiscalBuild && missing.length > 0) {
    concerns.push(`Fiscal configuration incomplete — missing ${missing.join(', ')}`)
  }

  return {
    generatedAt: input.generatedAt,

    software: {
      name: settings.softwareName,
      version: settings.softwareVersion,
      fiscalBuild: settings.fiscalBuild,
    },

    taxpayer: {
      tradeName: settings.tradeName ?? null,
      address: settings.address ?? null,
      // Printed on every receipt, so shown in full.
      tin: String(settings.tin ?? '').trim() || null,
      mrc: String(settings.mrc ?? '').trim() || null,
      sdcId: String(settings.sdcId ?? '').trim() || null,
      rraBranchCode: String(settings.rraBranchCode ?? '').trim() || null,
      // Configuration, not a receipt field — shown as set-or-not.
      vsdcUrl: tail(settings.vsdcUrl),
    },

    taxRates: settings.taxRates.map((rate) => ({
      category: rate.category,
      ratePercent: round2(rate.ratePercent),
    })),

    records: {
      fiscalReceipts: counts.fiscalReceipts,
      byType: counts.receiptsByType,
      pendingTransmission: counts.pendingTransmission,
      failedTransmission: counts.failedTransmission,
      cashMovements: counts.cashMovements,
      registeredItems: counts.registeredItems,
      coveringFrom: counts.firstReceiptAt ?? null,
      coveringTo: counts.lastReceiptAt ?? null,
    },

    // §7.3 — where each sequence currently stands. An auditor checking for gaps
    // starts here.
    counters: input.counters,

    missingConfiguration: missing,
    concerns,
    /** Nothing outstanding and nothing unconfigured. */
    clean: concerns.length === 0,
  }
}
