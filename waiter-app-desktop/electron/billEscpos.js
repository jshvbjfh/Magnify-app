// ESC/POS bill layout — pure byte building, no electron imports, so the exact
// paper output can be rendered and checked with plain node.
//
// Two hard rules shape everything here, both learned from bills that printed wrong:
//
// 1. A doubled character costs TWO columns. Laying a double-size row out at
//    half the column count is not enough — the printer wraps on ITS width, so
//    "TOTAL:     Rwf 17,000" came out as "TOTAL:     Rwf 1" / "7,000" and read
//    like the wrong amount. Every enlarged row below is measured in real
//    columns (doubled text counted twice) and shrinks a step rather than wrap.
//
// 2. The head renders bytes through a single-byte codepage. UTF-8 multi-byte
//    characters print as random kanji/katakana — one stray character in a
//    header template turned "TIN: 156646222" into "TIN:鉄 156646222". All text
//    is folded to ASCII on the way in.

'use strict'

const ESC = 0x1B
const GS = 0x1D

const FOLD = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'",
  '“': '"', '”': '"', '„': '"',
  '–': '-', '—': '-', '−': '-',
  '•': '*', '·': '*', '…': '...',
  '×': 'x', ' ': ' ', '€': 'EUR', '£': 'GBP',
}

// Fold to printable ASCII: known punctuation first, then accents via NFKD
// (café → cafe), then drop whatever has no ASCII equivalent at all.
function ascii(value) {
  return String(value == null ? '' : value)
    .replace(/[‘’‚‛“”„–—−•·…× €£]/g, ch => FOLD[ch])
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
}

function buildBillEscPos(data) {
  // Column count comes from the device's Printers-tab setting (falls back to
  // 32, the classic 58mm width) so alignment matches the physical printer.
  const cfgCols = Number(data.columns)
  const LINE = Number.isFinite(cfgCols) && cfgCols >= 24 && cfgCols <= 64 ? cfgCols : 32

  const parts = []
  const b = arr => Buffer.from(arr)
  const raw = s => Buffer.from(ascii(s), 'utf8')          // no line feed — for mixed-size rows
  const t = s => Buffer.from(ascii(s) + '\n', 'utf8')
  const feed = (n = 1) => b(new Array(n).fill(0x0A))
  const fmtNum = n => Math.round(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')

  const bold = on => b([ESC, 0x45, on ? 0x01 : 0x00])
  // GS ! n — high nibble width multiplier, low nibble height multiplier.
  const size = n => b([GS, 0x21, n])
  const SIZE_NORMAL = 0x00
  const SIZE_TALL = 0x01   // double height, still one column per character
  const SIZE_BIG = 0x11    // double height AND width — two columns per character

  // Left + right on one line when they fit; otherwise wrap the left text at
  // `width` and right-align the value on the last line — names never truncate.
  const cols = (left, right, width = LINE) => {
    if (!right) return [left]
    if (left.length + 1 + right.length <= width) {
      return [left + ' '.repeat(width - left.length - right.length) + right]
    }
    const lines = []
    let rest = left
    while (rest.length > width) { lines.push(rest.slice(0, width)); rest = rest.slice(width) }
    if (rest && rest.length + 1 + right.length <= width) {
      lines.push(rest + ' '.repeat(width - rest.length - right.length) + right)
    } else {
      if (rest) lines.push(rest)
      lines.push(' '.repeat(Math.max(0, width - right.length)) + right)
    }
    return lines
  }
  const rule = '-'.repeat(LINE)

  // Break template text on spaces before the printer breaks it mid-word: a
  // 35-character address printed "…Kigali, Rwa" / "nda". Words longer than the
  // paper still get hard-split — nothing else can be done with them.
  const wrapWords = (text, width) => {
    if (!text) return ['']
    const out = []
    let line = ''
    for (let word of text.split(/\s+/).filter(Boolean)) {
      while (word.length > width) {
        if (line) { out.push(line); line = '' }
        out.push(word.slice(0, width))
        word = word.slice(width)
      }
      if (!line) line = word
      else if (line.length + 1 + word.length <= width) line += ' ' + word
      else { out.push(line); line = word }
    }
    if (line) out.push(line)
    return out.length ? out : ['']
  }

  const parse = line => ({
    text: ascii(line).replace(/\*\*(.+?)\*\*/g, '$1').replace(/_(.+?)_/g, '$1').trim(),
    hasBold: /\*\*/.test(line),
  })

  // Init + center align. Centered sections rely on ESC a 1 (printer-side
  // centering) rather than space padding, so it stays correct when the
  // character size doubles.
  parts.push(b([ESC, 0x40]))
  parts.push(b([ESC, 0x61, 0x01]))

  // Top template text (supports **bold** markers). The first non-empty line —
  // the restaurant name — prints as the till header: double width + height when
  // the name fits in half the paper, double height only when it doesn't, so a
  // long name reads big instead of wrapping mid-word.
  let headerDone = false
  for (const line of (data.topText || 'RECEIPT').split('\n')) {
    const { text, hasBold } = parse(line)
    if (!headerDone && text) {
      headerDone = true
      const big = text.length * 2 <= LINE
      parts.push(size(big ? SIZE_BIG : SIZE_TALL), bold(true))
      for (const s of wrapWords(text, big ? Math.floor(LINE / 2) : LINE)) parts.push(t(s))
      parts.push(size(SIZE_NORMAL), bold(false))
      continue
    }
    if (hasBold) parts.push(bold(true))
    for (const s of wrapWords(text, LINE)) parts.push(t(s))
    if (hasBold) parts.push(bold(false))
  }
  parts.push(feed())

  // Left-align body
  parts.push(b([ESC, 0x61, 0x00]))
  parts.push(t(rule))
  for (const s of cols(`Server: ${ascii(data.server)}`, data.station ? `Station: ${ascii(data.station)}` : '')) parts.push(t(s))
  parts.push(t(rule))
  for (const s of cols(`Order #: ${ascii(data.orderNo)}`, ascii(data.orderType))) parts.push(t(s))
  if (data.tableName) parts.push(t(`Table: ${ascii(data.tableName)}`))
  parts.push(t(rule))

  // Items. The unit price is spelled out whenever more than one was ordered,
  // so a guest can check the line total without doing the division.
  for (const item of (data.items || [])) {
    const qty = Number(item.qty) || 0
    const unit = Number(item.unitPrice) || 0
    // noPrice: the line is settled elsewhere (a hotel buffet on credit), so it
    // is named on the bill but carries no amount — and no "@ each" either, both
    // of which would otherwise print as zero and read as a giveaway.
    if (item.noPrice) {
      for (const s of cols(`${qty} ${ascii(item.name).toUpperCase()}`, '')) parts.push(t(s))
      if (item.notes) parts.push(t(`  > ${ascii(item.notes)}`))
      continue
    }
    for (const s of cols(`${qty} ${ascii(item.name).toUpperCase()}`, fmtNum(unit * qty))) parts.push(t(s))
    if (qty > 1) parts.push(t(`  @ ${fmtNum(unit)} each`))
    if (item.notes) parts.push(t(`  > ${ascii(item.notes)}`))
  }
  parts.push(t(rule))

  // Total — the amount is the one thing on the bill that must never wrap, so
  // it is measured in real columns and steps down a size instead: big (two
  // columns per character), then tall, then plain. The label stays normal size
  // in the first two, which also keeps the row from ever needing the fallback
  // on a 32-column printer.
  const money = `Rwf ${fmtNum(data.totalAmount)}`
  const label = 'TOTAL'
  parts.push(bold(true))
  if (label.length + 1 + money.length * 2 <= LINE) {
    parts.push(raw(label + ' '.repeat(LINE - label.length - money.length * 2)))
    parts.push(size(SIZE_BIG), raw(money), feed(), size(SIZE_NORMAL))
  } else if (label.length + 1 + money.length <= LINE) {
    parts.push(raw(label + ' '.repeat(LINE - label.length - money.length)))
    parts.push(size(SIZE_TALL), raw(money), feed(), size(SIZE_NORMAL))
  } else {
    for (const s of cols(`${label}:`, money)) parts.push(t(s))
  }
  parts.push(bold(false))
  parts.push(t(rule))

  // Footer. Blank lines separate the ticket number, the timestamp and the
  // sign-off into three blocks — printed back to back they read as one squeezed
  // paragraph and the order number stops standing out.
  parts.push(b([ESC, 0x61, 0x01]))
  parts.push(feed())
  const ref = `>> ${ascii(data.orderNo)} <<`
  if (data.orderNo) {
    parts.push(bold(true), size(ref.length <= LINE ? SIZE_TALL : SIZE_NORMAL))
    parts.push(t(ref))
    parts.push(size(SIZE_NORMAL), bold(false))
  }
  if (data.dt) parts.push(t(data.dt))
  parts.push(feed())

  // Bottom template text (supports **bold** markers)
  const bottomRaw = (data.bottomText && data.bottomText.trim())
    ? data.bottomText
    : 'Thank you for dining with us!'
  for (const line of bottomRaw.split('\n')) {
    const { text, hasBold } = parse(line)
    if (hasBold) parts.push(bold(true))
    for (const s of wrapWords(text, LINE)) parts.push(t(s))
    if (hasBold) parts.push(bold(false))
  }
  parts.push(t('Powered by Magnify'))

  // Footer 2 — prints below "Powered by Magnify"; usually blank lines the
  // manager adds in the bill editor to push the footer past the cutter.
  if (data.footer2Text) {
    for (const line of String(data.footer2Text).split('\n')) {
      const { text, hasBold } = parse(line)
      if (hasBold) parts.push(bold(true))
      parts.push(t(text || ''))
      if (hasBold) parts.push(bold(false))
    }
  }

  // Barcode — CODE39 of the order number so bills scan at the till. CODE39
  // only covers 0-9 A-Z space $ % + - . / — anything else is stripped, and
  // the barcode is skipped entirely when nothing scannable remains.
  const bcData = ascii(data.orderNo).toUpperCase().replace(/[^0-9A-Z\-\. \$\/\+\%]/g, '')
  if (bcData && data.barcode !== false) {
    parts.push(feed())                            // air above the bars
    parts.push(b([GS, 0x48, 0x00]))               // no HRI text under the bars
    parts.push(b([GS, 0x68, 70]))                 // height: 70 dots
    parts.push(b([GS, 0x77, 0x02]))               // module width 2
    parts.push(b([GS, 0x6B, 69, bcData.length]))  // GS k CODE39, length-prefixed
    parts.push(Buffer.from(bcData, 'ascii'))
    parts.push(b([0x0A]))
  }

  // Feed + full cut.
  // 6 line feeds — was 4, but that left the last printed line (this footer) sitting right at the
  // cutter blade on some printers, so it got cut off and reappeared at the top of the next bill
  // instead of the bottom of this one. Extra feed gives it clearance to fully pass the blade first.
  parts.push(b([ESC, 0x61, 0x00]))
  parts.push(b([0x0A, 0x0A, 0x0A, 0x0A, 0x0A, 0x0A]))
  parts.push(b([GS, 0x56, 0x00]))

  return Buffer.concat(parts)
}

// Width ruler — nothing in software can measure the paper, and a bill laid out
// at 42 columns on a 32-column printer wraps every rule, every price and the
// total. Each probe line is exactly N characters wide and ends in a bar: the
// widest line that still ends with its bar on ONE line is the real width.
function buildWidthRuler(candidates = [32, 40, 42, 48]) {
  const parts = []
  const t = s => Buffer.from(ascii(s) + '\n', 'utf8')
  parts.push(Buffer.from([ESC, 0x40]))
  parts.push(Buffer.from([ESC, 0x61, 0x01]))
  parts.push(Buffer.from([ESC, 0x45, 0x01]))
  parts.push(t('BILL WIDTH TEST'))
  parts.push(Buffer.from([ESC, 0x45, 0x00]))
  parts.push(Buffer.from([ESC, 0x61, 0x00]))
  parts.push(t('Pick the biggest number whose'))
  parts.push(t('line ends with | on one line:'))
  parts.push(Buffer.from([0x0A]))
  for (const n of candidates) {
    const head = `${n} `
    parts.push(t(head + '-'.repeat(Math.max(0, n - head.length - 1)) + '|'))
  }
  parts.push(Buffer.from([0x0A]))
  parts.push(t('Set that number as Bill width'))
  parts.push(t('in the Printers tab.'))
  parts.push(Buffer.from([0x0A, 0x0A, 0x0A, 0x0A, 0x0A, 0x0A]))
  parts.push(Buffer.from([GS, 0x56, 0x00]))
  return Buffer.concat(parts)
}

module.exports = { buildBillEscPos, buildWidthRuler, ascii }
