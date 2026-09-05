/**
 * Three operational requirements that needed nothing from RRA:
 * TIN reset (§7.2), the audit interface (§7.26), print recovery (§7.28).
 */

import { describe, expect, it } from 'vitest'

import { buildAuditSnapshot } from '@/lib/fiscalAudit'
import { PRINT_JOB_STATES, blocksFurtherSales, planPrintRecovery } from '@/lib/fiscalPrintRecovery'
import { canChangeTin, describeTinChangeRefusal, describeTinResetPlan, isValidTin } from '@/lib/fiscalTinReset'

// ── §7.2 — changing the taxpayer ────────────────────────────────────────────

const VALID_CHANGE = {
  currentTin: '999999991',
  newTin: '888888882',
  inServiceMode: true,
  resetConfirmed: true,
  approvedByName: 'Marie',
}

describe('§7.2 — TIN changes', () => {
  it('allows a change that meets every condition', () => {
    expect(canChangeTin(VALID_CHANGE)).toBe(true)
  })

  it('refuses outside service mode', () => {
    expect(describeTinChangeRefusal({ ...VALID_CHANGE, inServiceMode: false }))
      .toBe('The TIN can only be changed in service mode')
  })

  it('refuses without confirmation of the erasure', () => {
    // The whole fiscal history goes with it. That takes a deliberate second
    // act, not a saved settings form.
    expect(describeTinChangeRefusal({ ...VALID_CHANGE, resetConfirmed: false }))
      .toContain('erases all fiscal history')
  })

  it('refuses without a named approver', () => {
    expect(describeTinChangeRefusal({ ...VALID_CHANGE, approvedByName: '  ' }))
      .toContain('named supervisor')
  })

  it('refuses a TIN that is not nine digits', () => {
    for (const newTin of ['12345', '9999999991', 'ABCDEFGHI', '']) {
      expect(canChangeTin({ ...VALID_CHANGE, newTin })).toBe(false)
    }
    expect(isValidTin('999999991')).toBe(true)
  })

  it('refuses re-saving the same TIN', () => {
    // Otherwise re-saving an unchanged settings form wipes the venue.
    expect(describeTinChangeRefusal({ ...VALID_CHANGE, newTin: '999999991' }))
      .toBe('That is already the current TIN')
  })

  it('spells out what will be destroyed, and that numbering restarts', () => {
    const plan = describeTinResetPlan(VALID_CHANGE)

    expect(plan.allowed).toBe(true)
    expect(plan.from).toBe('999999991')
    expect(plan.to).toBe('888888882')
    expect(plan.erases.join(' ')).toContain('fiscal receipt')
    expect(plan.erases.join(' ')).toContain('cash drawer')
    // §7.3
    expect(plan.countersRestartAt).toBe(1)
  })
})

// ── §7.26 — the audit interface ─────────────────────────────────────────────

const SETTINGS = {
  softwareName: 'Magnify',
  softwareVersion: '1.1.50',
  fiscalBuild: true,
  tin: '999999991',
  mrc: 'AAACC123456',
  sdcId: 'SDC001000001',
  rraBranchCode: '00',
  vsdcUrl: 'http://localhost:8080/vsdc',
  tradeName: 'High 5ive',
  address: 'Kigali',
  taxRates: [{ category: 'A', ratePercent: 0 }, { category: 'B', ratePercent: 18 }],
}

const COUNTS = {
  fiscalReceipts: 412,
  receiptsByType: { NS: 380, NR: 12, CS: 20 },
  pendingTransmission: 0,
  failedTransmission: 0,
  cashMovements: 31,
  registeredItems: 231,
}

describe('§7.26 — audit snapshot', () => {
  const snapshot = buildAuditSnapshot({
    settings: SETTINGS,
    counts: COUNTS,
    counters: [{ receiptType: 'NS', nextValue: 381 }, { receiptType: '*', nextValue: 413 }],
    generatedAt: '2026-09-05T12:00:00Z',
  })

  it('shows the software and version an auditor must verify (§7.7)', () => {
    expect(snapshot.software).toMatchObject({ name: 'Magnify', version: '1.1.50', fiscalBuild: true })
  })

  it('shows receipt-facing identifiers in full', () => {
    // These are printed on every receipt, so hiding them helps nobody.
    expect(snapshot.taxpayer.tin).toBe('999999991')
    expect(snapshot.taxpayer.mrc).toBe('AAACC123456')
    expect(snapshot.taxpayer.sdcId).toBe('SDC001000001')
  })

  it('masks the VSDC address rather than exposing it in full', () => {
    // Configuration an auditor should see the shape of — not a way to read
    // endpoints and credentials off a till.
    expect(snapshot.taxpayer.vsdcUrl).not.toBe(SETTINGS.vsdcUrl)
    expect(snapshot.taxpayer.vsdcUrl).toMatch(/vsdc$/)
  })

  it('shows where each counter stands, for a gap check (§7.3)', () => {
    expect(snapshot.counters).toEqual([
      { receiptType: 'NS', nextValue: 381 },
      { receiptType: '*', nextValue: 413 },
    ])
  })

  it('reports clean when nothing is outstanding', () => {
    expect(snapshot.concerns).toEqual([])
    expect(snapshot.clean).toBe(true)
  })

  it('raises anything an auditor would ask about rather than leaving them to spot it', () => {
    const flagged = buildAuditSnapshot({
      settings: { ...SETTINGS, sdcId: null, mrc: '' },
      counts: { ...COUNTS, pendingTransmission: 3, failedTransmission: 1 },
      counters: [],
      generatedAt: '2026-09-05T12:00:00Z',
    })

    expect(flagged.clean).toBe(false)
    expect(flagged.missingConfiguration).toEqual(expect.arrayContaining(['MRC', 'SDC ID']))
    expect(flagged.concerns.join(' ')).toContain('failed to transmit')
    expect(flagged.concerns.join(' ')).toContain('awaiting transmission')
    expect(flagged.concerns.join(' ')).toContain('configuration incomplete')
  })
})

// ── §7.28 — recovering an interrupted print ─────────────────────────────────

const JOB = {
  id: 'job-1',
  fiscalReceiptId: 'rcpt-1',
  state: PRINT_JOB_STATES.INTERRUPTED,
  totalLines: 40,
  linesPrinted: 18,
  originalCompleted: false,
}

describe('§7.28 — print recovery', () => {
  it('does nothing when nothing was interrupted', () => {
    expect(planPrintRecovery(null).action).toBe('none')
    expect(planPrintRecovery({ ...JOB, state: PRINT_JOB_STATES.COMPLETED }).action).toBe('none')
  })

  it('resumes a part-printed receipt from where it stopped', () => {
    expect(planPrintRecovery(JOB)).toMatchObject({ action: 'continue', fromLine: 18 })
  })

  it('restarts when nothing reached the paper', () => {
    expect(planPrintRecovery({ ...JOB, linesPrinted: 0 }).action).toBe('reprint-original')
  })

  it('prints a COPY once an original has completed (§7.18)', () => {
    // The guest already has their receipt. A second original would put two
    // receipts into the world for one sale, which §7.18 forbids outright.
    const action = planPrintRecovery({ ...JOB, originalCompleted: true })

    expect(action.action).toBe('reprint-as-copy')
    expect(action).toMatchObject({ message: expect.stringContaining('COPY') })
  })

  it('does not duplicate a receipt whose confirmation was merely lost', () => {
    expect(planPrintRecovery({ ...JOB, linesPrinted: 40 }).action).toBe('none')
  })

  it('stops further sales while a receipt is unfinished (§7.15)', () => {
    // The sale is registered but has no receipt, which is the condition §7.15
    // forbids — service stops until it is resolved.
    expect(blocksFurtherSales(JOB)).toBe(true)
    expect(blocksFurtherSales({ ...JOB, originalCompleted: true })).toBe(false)
    expect(blocksFurtherSales({ ...JOB, state: PRINT_JOB_STATES.COMPLETED })).toBe(false)
  })
})
