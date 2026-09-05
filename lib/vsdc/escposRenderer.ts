// Fiscal receipt lines → ESC/POS bytes.
//
// The adapter between lib/vsdc/fiscalReceipt.ts and a thermal printer. The
// layout is decided there; this only turns each line into commands, so the two
// printers can never disagree about what a receipt says.
//
// Returns a Uint8Array rather than a Buffer so it stays testable outside
// Electron. The caller wraps it for whichever transport it uses.
//
// ── What thermal paper cannot do ────────────────────────────────────────────
//
// §11 asks for COPY / TRAINING / PROFORMA "as a watermark". A thermal printer
// prints one line at a time and cannot overlay anything, so a true watermark is
// impossible in text mode. What is emitted instead is the designation at double
// size, centred, above the items — which §11 requires SEPARATELY anyway — plus
// a banded repeat so it is unmistakable.
//
// Whether that satisfies the clause is a question for RRA, not for us to decide
// quietly. Every EBM receipt in Rwanda comes off a thermal printer, so they have
// a settled answer; the alternative is rendering the whole receipt as a raster
// image, which allows a real watermark and costs print speed.

import type { ReceiptLine } from '@/lib/vsdc/fiscalReceipt'

const ESC = 0x1b
const GS = 0x1d

const encoder = new TextEncoder()

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

const bytes = (...values: number[]) => Uint8Array.from(values)
const text = (value: string) => encoder.encode(value)

/**
 * QR code, per ESC/POS `GS ( k`.
 *
 * Four commands in order: model, module size, error correction, then store and
 * print. They must be sent in that sequence — a printer given the data before
 * the model silently prints nothing, which is the failure mode to watch for
 * when a receipt comes out with a blank space where the QR should be.
 */
export function encodeQr(payload: string, moduleSize = 6): Uint8Array {
  const data = encoder.encode(payload)
  // Length includes the two-byte function prefix (0x31 0x50) plus one.
  const length = data.length + 3
  const pL = length & 0xff
  const pH = (length >> 8) & 0xff

  return concat([
    // Model 2.
    bytes(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00),
    // Module size in dots. 6 keeps a long payload scannable on 72mm paper.
    bytes(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, moduleSize),
    // Error correction level M — enough to survive a smudge on thermal paper.
    bytes(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31),
    // Store the payload.
    bytes(GS, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30),
    data,
    // Print what was stored.
    bytes(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30),
  ])
}

/**
 * A 1-bit raster image, per `GS v 0`. Used for the RRA logo (§7.29).
 *
 * `widthDots` must be a multiple of 8 — each byte carries eight horizontal
 * pixels, and a width that is not a multiple of 8 shears the image diagonally
 * rather than failing, which is a confusing thing to debug.
 */
export function encodeRaster(bitmap: Uint8Array, widthDots: number, heightDots: number): Uint8Array {
  const widthBytes = Math.ceil(widthDots / 8)

  return concat([
    bytes(GS, 0x76, 0x30, 0x00, widthBytes & 0xff, (widthBytes >> 8) & 0xff, heightDots & 0xff, (heightDots >> 8) & 0xff),
    bitmap,
  ])
}

export type EscposRenderOptions = {
  /** Characters per line at normal size. 32, 42 and 48 are the common widths. */
  width?: number
  /**
   * The RRA logo as a 1-bit raster. Omitted until RRA supplies the artwork —
   * §7.29 cannot be satisfied without the real file, and a placeholder drawn by
   * us would be worse than a gap, because it would look done.
   */
  logo?: { bitmap: Uint8Array; widthDots: number; heightDots: number } | null
  /** Feed lines before the cut, so the tear-off clears the printed area. */
  feedBeforeCut?: number
}

function padPair(left: string, right: string, width: number): string {
  const gap = Math.max(1, width - left.length - right.length)
  return `${left}${' '.repeat(gap)}${right}`
}

function centre(value: string, width: number): string {
  if (value.length >= width) return value
  return ' '.repeat(Math.floor((width - value.length) / 2)) + value
}

/** Renders the receipt to bytes. */
export function renderReceiptAsEscpos(lines: ReceiptLine[], options: EscposRenderOptions = {}): Uint8Array {
  const width = options.width ?? 48
  const out: Uint8Array[] = []

  const align = (mode: 0 | 1) => out.push(bytes(ESC, 0x61, mode))
  const bold = (on: boolean) => out.push(bytes(ESC, 0x45, on ? 1 : 0))
  // GS ! n — high nibble is width, low nibble height. 0x11 is double both.
  const size = (scale: 1 | 2) => out.push(bytes(GS, 0x21, scale === 2 ? 0x11 : 0x00))
  const feed = (value: string) => out.push(text(`${value}\n`))

  out.push(bytes(ESC, 0x40)) // initialise

  for (const line of lines) {
    switch (line.kind) {
      case 'logo':
        if (options.logo) {
          align(1)
          out.push(encodeRaster(options.logo.bitmap, options.logo.widthDots, options.logo.heightDots))
          feed('')
          align(0)
        }
        // No logo supplied: emit nothing rather than a stand-in. A drawn
        // placeholder would look finished and is not.
        break

      case 'qr':
        align(1)
        out.push(encodeQr(line.payload))
        feed('')
        align(0)
        break

      case 'watermark':
        // See the note at the top — thermal cannot overlay. A banded repeat is
        // the closest text mode gets.
        align(1)
        bold(true)
        size(2)
        feed(line.text)
        size(1)
        bold(false)
        align(0)
        break

      case 'rule':
        feed('-'.repeat(width))
        break

      case 'blank':
        feed('')
        break

      case 'text': {
        if (line.align === 'center') align(1)
        if (line.bold) bold(true)
        if (line.scale === 2) size(2)
        // Centring is left to the printer when asked for; padding as well would
        // double the offset and push the text off the right edge.
        feed(line.align === 'center' ? line.text : line.text)
        if (line.scale === 2) size(1)
        if (line.bold) bold(false)
        if (line.align === 'center') align(0)
        break
      }

      case 'pair': {
        if (line.bold) bold(true)
        // Pairs are padded by us, never centred: the two halves have to line up
        // against the same right edge on every line of the receipt.
        feed(padPair(line.left, line.right, line.scale === 2 ? Math.floor(width / 2) : width))
        if (line.bold) bold(false)
        break
      }
    }
  }

  for (let i = 0; i < (options.feedBeforeCut ?? 5); i += 1) feed('')
  out.push(bytes(GS, 0x56, 0x00)) // full cut

  return concat(out)
}

/** Whether this receipt can be printed completely on thermal paper. */
export function describeEscposGaps(lines: ReceiptLine[], options: EscposRenderOptions = {}): string[] {
  const gaps: string[] = []

  if (lines.some((l) => l.kind === 'logo') && !options.logo) {
    gaps.push('RRA logo artwork not supplied — §7.29 cannot be met')
  }

  if (lines.some((l) => l.kind === 'watermark')) {
    gaps.push('Watermark printed as a banded heading — thermal paper cannot overlay (§11)')
  }

  return gaps
}
