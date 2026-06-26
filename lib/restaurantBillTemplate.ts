const BILL_FOOTER_DELIMITER = '\n---MAGNIFY-FOOTER---\n'

// Blank lines are intentional vertical spacing the manager adds between sections
// of the receipt, so the header/footer text is preserved verbatim — NOT trimmed.
// Trimming here deleted the spacing the manager put between the header and the
// body (and before the footer), which is why that spacing never printed.
export function parseRestaurantBillTemplate(rawValue: string | null | undefined) {
  const normalized = typeof rawValue === 'string' ? rawValue : ''
  const parts = normalized.split(BILL_FOOTER_DELIMITER)

  return {
    topText: parts[0] ?? '',
    bottomText: parts[1] ?? '',
  }
}

export function composeRestaurantBillTemplate(topText: string, bottomText: string) {
  const top = topText ?? ''
  const bottom = bottomText ?? ''

  // A footer that is only blank/whitespace counts as "no footer"; otherwise keep
  // both halves exactly as typed so the manager's blank-line spacing survives.
  if (bottom.trim() === '') return top
  return `${top}${BILL_FOOTER_DELIMITER}${bottom}`
}
