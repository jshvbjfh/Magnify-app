// Android printing — CURRENTLY NON-FUNCTIONAL. Nothing here reaches paper.
//
// Same public surface as waiter-app-desktop/src/services/printing.ts so the
// shared pages compile and behave identically — but Android has no Windows
// print spooler and no raw-socket API in the WebView, so the two hardware paths
// the desktop uses (GDI receipts via Electron IPC, ESC/POS bytes over TCP or
// into a USB queue) do not exist here.
//
// Everything therefore routes to the WebView's own window.print() — and that is
// a dead end, not a fallback. Android System WebView does NOT implement
// window.print(): unlike Chrome, it is a documented no-op that fails silently,
// with no dialog, no error and no paper. There is also no print plugin in the
// Capacitor config and MainActivity is a bare BridgeActivity, so no native
// bridge exists either. Bills and tickets simply do not print from the APK.
//
// Making this work needs BOTH:
//   1. a native plugin — TCP socket to a printer at host:9100, or Bluetooth
//      ESC/POS. The byte layouts already exist in
//      waiter-app-desktop/electron/billEscpos.js and buildTicketEscPos, and
//      would be ported to TS so the plugin only has to move bytes.
//   2. a reachable printer — as of 2026-08-14 no restaurant has billPrinterIp
//      set; every thermal printer is USB-attached to a Windows terminal, which
//      a tablet cannot reach by any means.
//
// Deliberately left as-is: tablets are order-entry only, and all printing
// happens at the Windows terminals. Do not "fix" the getters below to report
// available without doing (1) and (2) — that only swaps a silent no-op for a
// thrown error.
//
// The ESC/POS getters below deliberately report "unavailable" so
// RestaurantOrders takes its HTML branch instead of dead-ending on a raw path
// that can never succeed on this platform.

import { getConfig, setConfig } from './db'

export interface PrinterInfo {
  name: string
  displayName: string
  isDefault: boolean
}

// branchId → printer deviceName. The key '__none__' covers dishes with no branch.
export type PrinterMap = Record<string, string>

const MAP_KEY = 'stationPrinters'
const BILL_KEY = 'billPrinter'

export interface NetworkPrinterConfig { ip: string; port: number }

// The manager stores the editable bill as top + bottom (+ optional footer2)
// text joined by these delimiters (see lib/restaurantBillTemplate.ts on the
// server). Keep in sync with the desktop copy. footer2 prints below the
// hard-coded "Powered by Magnify" line — mostly blank lines that push the
// footer past the cutter.
const BILL_FOOTER_DELIMITER = '\n---MAGNIFY-FOOTER---\n'
const BILL_FOOTER2_DELIMITER = '\n---MAGNIFY-FOOTER2---\n'

export function parseBillTemplate(raw: string | null | undefined): { topText: string; bottomText: string; footer2Text: string } {
  const normalized = typeof raw === 'string' ? raw : ''
  const [beforeFooter2, footer2] = normalized.split(BILL_FOOTER2_DELIMITER)
  const parts = (beforeFooter2 ?? '').split(BILL_FOOTER_DELIMITER)
  // Preserve blank lines — they're the manager's intentional vertical spacing.
  return { topText: parts[0] ?? '', bottomText: parts[1] ?? '', footer2Text: footer2 ?? '' }
}

// Kept for signature parity with the desktop. Android's print dialog lets the
// user pick the target, so there is no silent virtual-printer trap to avoid.
export function isVirtualPrinter(name: string): boolean {
  return /pdf|xps|onenote|fax|microsoft print/i.test(name || '')
}

// Android exposes no enumerable printer list to the WebView — the system print
// dialog owns discovery. An empty list makes the shared pages fall back to the
// system dialog rather than trying to address a device by name.
export async function listPrinters(): Promise<PrinterInfo[]> {
  return []
}

// Renders the slip into the page and calls window.print(). On Android that call
// does nothing at all (see the file header) — the DOM work below is correct and
// ready, but the final hand-off never happens, so no paper comes out.
function printHtmlViaSystem(html: string): void {
  const ID = `mg-print-${Date.now()}`
  const SID = `${ID}-style`
  const parsed = new DOMParser().parseFromString(html, 'text/html')

  const styleEl = document.createElement('style')
  styleEl.id = SID
  styleEl.textContent =
    Array.from(parsed.querySelectorAll('style')).map(s => s.textContent ?? '').join('\n')
    + `\n@media screen{#${ID}{position:fixed;left:-9999px;top:0;width:58mm;opacity:0}}`
    + `\n@media print{body>*:not(#${ID}){display:none!important}#${ID}{display:block!important;position:static!important}}`

  const div = document.createElement('div')
  div.id = ID
  div.innerHTML = parsed.body.innerHTML

  document.head.appendChild(styleEl)
  document.body.appendChild(div)

  requestAnimationFrame(() => requestAnimationFrame(() => {
    window.print()
    window.addEventListener('afterprint', () => {
      document.getElementById(ID)?.remove()
      document.getElementById(SID)?.remove()
    }, { once: true })
  }))
}

// Print a short test slip so staff can confirm the print service works. The
// deviceName is ignored — Android's dialog owns target selection.
export async function testPrint(_deviceName: string, label: string): Promise<void> {
  const safe = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  printHtmlViaSystem(`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:monospace;font-size:12px;width:58mm;padding:4mm;text-align:center}
.title{font-size:15px;font-weight:bold;margin-bottom:6px}
.divider{border-top:1px dashed #000;margin:6px 0}
@media print{@page{margin:0;size:58mm auto}}
</style></head><body>
<div class="title">PRINTER TEST</div>
<div class="divider"></div>
<div>${safe}</div>
<div>${new Date().toLocaleString()}</div>
<div class="divider"></div>
<div>If you can read this, the printer is working.</div>
</body></html>`)
}

export async function getPrinterMap(): Promise<PrinterMap> {
  try {
    const raw = await getConfig(MAP_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as PrinterMap) : {}
  } catch {
    return {}
  }
}

export async function setPrinterMap(map: PrinterMap): Promise<void> {
  await setConfig(MAP_KEY, JSON.stringify(map))
}

export async function getBillPrinter(): Promise<string> {
  return (await getConfig(BILL_KEY)) ?? ''
}

export async function setBillPrinter(deviceName: string): Promise<void> {
  await setConfig(BILL_KEY, deviceName)
}

const ESCPOS_KEY = 'billEscposMode'

// Always false on Android: the toggle only makes sense where we can emit raw
// bytes to a queue. Reporting true would send RestaurantOrders down the
// printBillRaw path, which throws here — and the bill would never print at all.
export async function getBillEscposMode(): Promise<boolean> {
  return false
}

// Stored so the setting survives if this device is ever inspected or the value
// is shared with a desktop terminal, but it does not change Android behaviour.
export async function setBillEscposMode(on: boolean): Promise<void> {
  await setConfig(ESCPOS_KEY, on ? '1' : '')
}

// Null on Android even when the manager has synced a printer IP: reaching a
// network thermal printer needs a raw TCP socket, which the WebView cannot open.
// Returning the IP anyway would make RestaurantOrders take the ESC/POS branch
// and abandon the bill instead of falling through to the system print path.
export async function getBillNetworkPrinter(): Promise<NetworkPrinterConfig | null> {
  return null
}

export async function printBillRaw(_data: object): Promise<{ ok: boolean; error?: string }> {
  throw new Error('Raw thermal printing is not available on Android — use the system print dialog')
}

// Signature parity with the desktop only. Unreachable here: the ESC/POS ticket
// branch in RestaurantOrders is gated on getBillEscposMode() / a network
// printer, and both report unavailable above, so tickets always take the
// system print path on Android.
export async function printTicketRaw(_data: object): Promise<{ ok: boolean; error?: string }> {
  throw new Error('Raw thermal printing is not available on Android — use the system print dialog')
}

// Resolve the printer for a station: its own mapping, else the bill printer,
// else '' (which lets the system dialog choose).
export function resolveStationPrinter(map: PrinterMap, billPrinter: string, branchId: string | null): string {
  const key = branchId ?? '__none__'
  return map[key] || billPrinter || ''
}
