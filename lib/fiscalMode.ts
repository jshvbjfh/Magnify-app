// Whether this is a fiscal build.
//
// ── Why this is not a setting ───────────────────────────────────────────────
//
// A system certified by RRA must have no way to stop charging VAT. Not a
// toggle, not a database column, not an environment value an operator can
// change after install. If turning VAT off is possible at all, the system is
// not a certified invoicing system — it is a system that can pretend to be one.
//
// So the decision is made when the installer is built and is then frozen. There
// is deliberately:
//
//   - no `rraFiscalMode` column on Restaurant (an earlier draft had one; it was
//     removed for exactly this reason),
//   - no settings screen mentioning VAT,
//   - no runtime path that turns it off.
//
// v1.0.50 and later fiscal builds ship with RRA_FISCAL_MODE=on baked in.
// Everything else is a non-fiscal build for development and for venues outside
// Rwanda, and keeps the behaviour it has always had.
//
// ── "Not configured" is not "VAT off" ───────────────────────────────────────
//
// A fiscal build whose TIN, SDC id or MRC is missing has not been registered
// with RRA yet. It must REFUSE TO TRADE — not quietly trade without VAT. Those
// two outcomes look similar from the code and are opposite in law, which is why
// `describeFiscalConfigurationGap` exists and returns a reason rather than a
// boolean.

/** True when this build charges VAT and issues fiscal receipts. */
export function isFiscalBuild(): boolean {
  return String(process.env.RRA_FISCAL_MODE ?? '').trim().toLowerCase() === 'on'
}

export type FiscalConfiguration = {
  tin?: string | null
  sdcId?: string | null
  mrc?: string | null
  rraBranchCode?: string | null
  vsdcUrl?: string | null
}

const REQUIRED_FIELDS: Array<{ key: keyof FiscalConfiguration; label: string }> = [
  { key: 'tin', label: 'TIN' },
  { key: 'sdcId', label: 'SDC ID' },
  { key: 'mrc', label: 'MRC' },
  { key: 'rraBranchCode', label: 'branch code' },
  { key: 'vsdcUrl', label: 'VSDC address' },
]

/**
 * Why this outlet cannot issue receipts yet, or null when it can.
 *
 * One line, naming what is missing, because it is read by whoever is standing
 * at the till trying to open for service — they need the next step, not a
 * diagnosis. On a non-fiscal build there is nothing to configure and this is
 * always null.
 */
export function describeFiscalConfigurationGap(config: FiscalConfiguration): string | null {
  if (!isFiscalBuild()) return null

  const missing = REQUIRED_FIELDS
    .filter(({ key }) => !String(config[key] ?? '').trim())
    .map(({ label }) => label)

  if (missing.length === 0) return null

  return `Not registered with RRA yet — missing ${missing.join(', ')}`
}

/** Whether this outlet may issue receipts. */
export function canIssueFiscalReceipts(config: FiscalConfiguration): boolean {
  return describeFiscalConfigurationGap(config) === null
}

/**
 * Service mode (§7.2).
 *
 *   "have reprogrammable TIN under its service mode"
 *
 * The clause puts the TIN behind a mode that normal operation cannot reach,
 * because changing it erases the venue's entire fiscal history. So it is an
 * environment value, set on the machine by whoever is performing the handover
 * and removed afterwards — not a switch in the settings screen, which is
 * exactly the thing a manager could find by accident.
 *
 * Deliberately NOT the same shape of decision as isFiscalBuild(): that one is
 * frozen into the installer and must never move, while this one is meant to be
 * turned on for an afternoon and turned off again.
 */
export function isServiceMode(): boolean {
  return String(process.env.MAGNIFY_SERVICE_MODE ?? '').trim().toLowerCase() === 'on'
}
