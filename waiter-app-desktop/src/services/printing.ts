// Per-station printer mapping (device-local).
//
// The app routes each kitchen/bar branch's ticket to a specific Windows printer,
// and the customer bill to a designated "bill" printer. Mappings are stored in
// the local restaurant_config table — they are device-specific and never synced.

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

function getElectronPrint() {
  return (window as Window & {
    electronPrint?: {
      receipt: (html: string, deviceName?: string) => Promise<void>
      listPrinters?: () => Promise<PrinterInfo[]>
      printBillRaw?: (data: object) => Promise<{ ok: boolean; error?: string }>
    }
  }).electronPrint
}

// Print a short test slip to the given printer so staff can confirm the mapping.
export async function testPrint(deviceName: string, label: string): Promise<void> {
  const ep = getElectronPrint()
  if (!ep) throw new Error('Printing not available')
  const safe = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
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
</body></html>`
  await ep.receipt(html, deviceName || undefined)
}

// The manager stores the editable bill as top + bottom (+ optional footer2)
// text joined by these delimiters (see lib/restaurantBillTemplate.ts on the
// server). Keep in sync. footer2 prints below the hard-coded "Powered by
// Magnify" line — mostly blank lines that push the footer past the cutter.
const BILL_FOOTER_DELIMITER = '\n---MAGNIFY-FOOTER---\n'
const BILL_FOOTER2_DELIMITER = '\n---MAGNIFY-FOOTER2---\n'

export function parseBillTemplate(raw: string | null | undefined): { topText: string; bottomText: string; footer2Text: string } {
  const normalized = typeof raw === 'string' ? raw : ''
  const [beforeFooter2, footer2] = normalized.split(BILL_FOOTER2_DELIMITER)
  const parts = (beforeFooter2 ?? '').split(BILL_FOOTER_DELIMITER)
  // Preserve blank lines — they're the manager's intentional vertical spacing.
  return { topText: parts[0] ?? '', bottomText: parts[1] ?? '', footer2Text: footer2 ?? '' }
}

// Virtual printers (PDF/XPS/OneNote/Fax) pop a file-save dialog instead of
// printing paper — never a valid receipt target.
export function isVirtualPrinter(name: string): boolean {
  return /pdf|xps|onenote|fax|microsoft print/i.test(name || '')
}

export async function listPrinters(): Promise<PrinterInfo[]> {
  const ep = getElectronPrint()
  if (!ep?.listPrinters) return []
  try {
    return await ep.listPrinters()
  } catch {
    return []
  }
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

// Styled thermal bills (ESC/POS) on the local Windows bill printer — big
// header, bold total, barcode. Opt-in per device: a non-thermal printer would
// print the ESC/POS control bytes as garbage characters.
const ESCPOS_KEY = 'billEscposMode'

export async function getBillEscposMode(): Promise<boolean> {
  return (await getConfig(ESCPOS_KEY)) === '1'
}

export async function setBillEscposMode(on: boolean): Promise<void> {
  await setConfig(ESCPOS_KEY, on ? '1' : '')
}

export async function getBillNetworkPrinter(): Promise<NetworkPrinterConfig | null> {
  try {
    const ip = await getConfig('billPrinterIp')
    if (!ip) return null
    const portStr = await getConfig('billPrinterPort')
    const port = portStr ? parseInt(portStr) : 9100
    return { ip, port }
  } catch { return null }
}

export async function printBillRaw(data: object): Promise<{ ok: boolean; error?: string }> {
  const ep = getElectronPrint()
  if (!ep?.printBillRaw) throw new Error('ESC/POS bill printing not available')
  return ep.printBillRaw(data)
}

// Resolve the printer for a station: its own mapping, else the bill printer,
// else '' (which falls back to the OS default printer in the main process).
export function resolveStationPrinter(map: PrinterMap, billPrinter: string, branchId: string | null): string {
  const key = branchId ?? '__none__'
  return map[key] || billPrinter || ''
}
