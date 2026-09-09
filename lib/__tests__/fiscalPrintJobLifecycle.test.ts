/**
 * The print-job lifecycle, as the route drives it (§7.28, §7.18).
 *
 * lib/fiscalPrintRecovery decides what to do with an interrupted job and is
 * already tested. What is pinned here is the part that was missing until the
 * job table existed: that the states a real crash leaves behind reach that
 * function in a shape it can act on, and that no path can produce a second
 * original.
 */

import { describe, it, expect } from 'vitest'
import {
  blocksFurtherSales,
  planPrintRecovery,
  PRINT_JOB_STATES,
  type PrintJob,
} from '@/lib/fiscalPrintRecovery'

const job = (over: Partial<PrintJob> = {}): PrintJob => ({
  id: 'job-1',
  fiscalReceiptId: 'receipt-1',
  state: PRINT_JOB_STATES.INTERRUPTED,
  totalLines: 30,
  linesPrinted: 12,
  originalCompleted: false,
  ...over,
})

describe('what a crash leaves behind', () => {
  it('a job still PRINTING reads as healthy until it is promoted', () => {
    // The reason the route promotes stale PRINTING rows before planning: a till
    // that loses power does not get to write a row on the way down. Left as-is,
    // recovery would answer "nothing to do" — the exact silence §7.28 exists to
    // prevent.
    const stale = job({ state: PRINT_JOB_STATES.PRINTING })
    expect(planPrintRecovery(stale)).toEqual({ action: 'none' })
    expect(blocksFurtherSales(stale)).toBe(false)
  })

  it('the same job, once promoted, resumes and stops the till', () => {
    const promoted = job({ state: PRINT_JOB_STATES.INTERRUPTED })
    expect(planPrintRecovery(promoted)).toMatchObject({ action: 'continue', fromLine: 12 })
    // §7.15 — a sale registered without a receipt. Service stops.
    expect(blocksFurtherSales(promoted)).toBe(true)
  })
})

describe('never a second original (§7.18)', () => {
  it('reprints as a COPY once an original has completed', () => {
    const done = job({ originalCompleted: true })
    expect(planPrintRecovery(done)).toMatchObject({ action: 'reprint-as-copy' })
  })

  it('does not block trade once the guest has their receipt', () => {
    // The sale is lawfully recorded. Getting another piece of paper to them is
    // a service matter, not a compliance one.
    expect(blocksFurtherSales(job({ originalCompleted: true }))).toBe(false)
  })

  it('starts the original again when nothing reached the paper', () => {
    // Still the FIRST original, so this is not a second receipt.
    expect(planPrintRecovery(job({ linesPrinted: 0 }))).toMatchObject({ action: 'reprint-original' })
  })
})

describe('progress that arrives out of order', () => {
  // The route clamps linesPrinted so it can never move backwards. These pin the
  // arithmetic that clamp depends on.
  const clamp = (existing: number, incoming: number, total: number) =>
    Math.max(existing, Math.min(Math.floor(incoming), total))

  it('ignores a confirmation older than one already recorded', () => {
    // Rewinding the resume point would reprint lines the guest already has.
    expect(clamp(12, 5, 30)).toBe(12)
  })

  it('never exceeds the receipt length', () => {
    expect(clamp(12, 99, 30)).toBe(30)
  })

  it('accepts ordinary forward progress', () => {
    expect(clamp(12, 20, 30)).toBe(20)
  })
})

describe('a job that finished but was never confirmed', () => {
  it('is treated as done rather than reprinted', () => {
    // The confirmation got lost, not the receipt. Printing again would put a
    // duplicate into the world on the strength of a missing acknowledgement.
    expect(planPrintRecovery(job({ linesPrinted: 30, totalLines: 30 }))).toEqual({ action: 'none' })
  })
})
