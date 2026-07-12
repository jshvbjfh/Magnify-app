const BILL_FOOTER_DELIMITER = '\n---MAGNIFY-FOOTER---\n'
const BILL_FOOTER2_DELIMITER = '\n---MAGNIFY-FOOTER2---\n'

// Blank lines are intentional vertical spacing the manager adds between sections
// of the receipt, so the header/footer text is preserved verbatim — NOT trimmed.
// Trimming here deleted the spacing the manager put between the header and the
// body (and before the footer), which is why that spacing never printed.
//
// footer2Text prints BELOW the hard-coded "Powered by Magnify" line — its main
// purpose is blank lines that push the footer up past the printer's cutter.
export function parseRestaurantBillTemplate(rawValue: string | null | undefined) {
  const normalized = typeof rawValue === 'string' ? rawValue : ''
  const [beforeFooter2, footer2] = normalized.split(BILL_FOOTER2_DELIMITER)
  const parts = (beforeFooter2 ?? '').split(BILL_FOOTER_DELIMITER)

  return {
    topText: parts[0] ?? '',
    bottomText: parts[1] ?? '',
    footer2Text: footer2 ?? '',
  }
}

export function composeRestaurantBillTemplate(topText: string, bottomText: string, footer2Text = '') {
  const top = topText ?? ''
  const bottom = bottomText ?? ''
  const footer2 = footer2Text ?? ''

  // A footer that is only blank/whitespace counts as "no footer"; otherwise keep
  // the sections exactly as typed so the manager's blank-line spacing survives.
  // footer2 is spacing-by-design, so blank lines alone still count as content —
  // only a fully empty string drops the section.
  let result = bottom.trim() === '' && footer2 === ''
    ? top
    : `${top}${BILL_FOOTER_DELIMITER}${bottom}`
  if (footer2 !== '') result += `${BILL_FOOTER2_DELIMITER}${footer2}`
  return result
}
