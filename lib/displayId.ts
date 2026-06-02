// Alphabet: uppercase, excludes confusing chars O/0/1/I/L
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 32 chars

/**
 * Converts any internal ID (CUID, UUID, etc.) to a deterministic 7-char
 * human-readable code like "Id #A3F9C12". Safe to display to managers.
 * The real ID is never changed — this is display-only.
 */
export function shortId(rawId: string): string {
  let h = 5381
  for (let i = 0; i < rawId.length; i++) {
    h = (((h << 5) + h) ^ rawId.charCodeAt(i)) >>> 0
  }
  let result = ''
  let n = h
  for (let i = 0; i < 7; i++) {
    result += ALPHA[n % ALPHA.length]
    n = Math.floor(n / ALPHA.length)
  }
  return `Id #${result}`
}

/**
 * Replaces raw CUID-style IDs inside bracket notation — e.g.
 * "DishSale: Milkshake [cmpl0fo6801c8s]" → "DishSale: Milkshake Id #A3F9C12"
 */
export function fmtDesc(desc: string | null | undefined): string {
  if (!desc) return ''
  return desc.replace(/\[([a-z0-9]{10,})\]/g, (_, id) => shortId(id))
}
