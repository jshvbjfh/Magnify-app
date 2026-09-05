// Fiscal receipt lines → HTML, for system printers.
//
// The second of the two adapters. Same lines in, so this and the ESC/POS
// renderer cannot disagree about what the receipt says — which is the whole
// reason the layout was defined once rather than in each renderer.
//
// Unlike thermal, HTML CAN do a true watermark (§11): the browser composites,
// so COPY sits behind the text as the clause describes. Where the two renderers
// differ, they differ because the paper does — not because someone implemented
// them separately.

import type { ReceiptLine } from '@/lib/vsdc/fiscalReceipt'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export type HtmlRenderOptions = {
  /** Characters per line, used to size the monospace column. */
  width?: number
  /** Data URI for the RRA logo. Omitted until RRA supplies the artwork. */
  logoDataUri?: string | null
  /** Data URI for a pre-rendered QR image, if the caller generated one. */
  qrDataUri?: string | null
}

function pair(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - left.length - right.length)
  return `${left}${' '.repeat(gap)}${right}`
}

/**
 * Renders the receipt as a self-contained HTML document.
 *
 * Monospace and fixed-width throughout, so the pairs line up exactly as they do
 * on thermal paper — a guest comparing a reprinted receipt against the original
 * should see the same document, not a prettier one.
 */
export function renderReceiptAsHtml(lines: ReceiptLine[], options: HtmlRenderOptions = {}): string {
  const width = options.width ?? 48
  const body: string[] = []
  let watermark: string | null = null

  for (const line of lines) {
    switch (line.kind) {
      case 'logo':
        if (options.logoDataUri) {
          body.push(`<div class="c"><img class="logo" src="${escapeHtml(options.logoDataUri)}" alt=""></div>`)
        }
        break

      case 'qr':
        if (options.qrDataUri) {
          body.push(`<div class="c"><img class="qr" src="${escapeHtml(options.qrDataUri)}" alt=""></div>`)
        } else {
          // The payload still has to reach the paper even without an image, so
          // the receipt is never silently missing its verification data.
          body.push(`<div class="qrtext">${escapeHtml(line.payload)}</div>`)
        }
        break

      case 'watermark':
        // Held back and composited behind everything, which is what §11 asks
        // for and what thermal cannot do.
        watermark = line.text
        break

      case 'rule':
        body.push(`<div class="l">${'-'.repeat(width)}</div>`)
        break

      case 'blank':
        body.push('<div class="l">&nbsp;</div>')
        break

      case 'text': {
        const classes = ['l']
        if (line.align === 'center') classes.push('c')
        if (line.bold) classes.push('b')
        if (line.scale === 2) classes.push('big')
        body.push(`<div class="${classes.join(' ')}">${escapeHtml(line.text) || '&nbsp;'}</div>`)
        break
      }

      case 'pair': {
        const classes = ['l']
        if (line.bold) classes.push('b')
        body.push(`<div class="${classes.join(' ')}">${escapeHtml(pair(line.left, line.right, width))}</div>`)
        break
      }
    }
  }

  const watermarkMarkup = watermark
    ? `<div class="wm">${escapeHtml(watermark)}</div>`
    : ''

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Receipt</title><style>
  @page { margin: 4mm; }
  body { margin: 0; font-family: "Courier New", Courier, monospace; font-size: 12px;
         line-height: 1.25; position: relative; }
  .l { white-space: pre; }
  .c { text-align: center; }
  .b { font-weight: bold; }
  .big { font-size: 24px; line-height: 1.15; font-weight: bold; }
  .logo { max-width: 60%; }
  .qr { width: 120px; height: 120px; }
  .qrtext { word-break: break-all; font-size: 9px; text-align: center; }
  /* §11 — the designation sits BEHIND the text, which is what "watermark"
     means and what a thermal printer cannot do. */
  .wm { position: fixed; top: 45%; left: 50%; transform: translate(-50%, -50%) rotate(-30deg);
        font-size: 64px; font-weight: bold; color: rgba(0,0,0,0.12);
        pointer-events: none; z-index: 0; white-space: nowrap; }
  .content { position: relative; z-index: 1; }
</style></head><body>${watermarkMarkup}<div class="content">${body.join('')}</div></body></html>`
}
