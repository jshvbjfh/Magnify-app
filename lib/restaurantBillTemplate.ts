const BILL_FOOTER_DELIMITER = '\n---MAGNIFY-FOOTER---\n'

export function parseRestaurantBillTemplate(rawValue: string | null | undefined) {
  const normalized = typeof rawValue === 'string' ? rawValue : ''
  const parts = normalized.split(BILL_FOOTER_DELIMITER)

  return {
    topText: (parts[0] ?? '').trim(),
    bottomText: (parts[1] ?? '').trim(),
  }
}

export function composeRestaurantBillTemplate(topText: string, bottomText: string) {
  const normalizedTop = topText.trim()
  const normalizedBottom = bottomText.trim()

  if (!normalizedBottom) return normalizedTop
  return `${normalizedTop}${BILL_FOOTER_DELIMITER}${normalizedBottom}`
}
