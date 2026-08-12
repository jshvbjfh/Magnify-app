// Item-name completion for the stock recorder.
//
// The recorder suggests what the user filled in last time for an item, so a
// repeat purchase is a keystroke instead of a re-typed row. Both helpers are
// generic over the row shape: they only need a name and a recording time, so
// pending queue rows and saved purchases can be fed in together.

export type ItemEntryLike = { ingredient: { name: string }; createdAt: string }

function recordedAt(entry: ItemEntryLike) {
  const parsed = new Date(entry.createdAt).getTime()
  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * One entry per item — the last one recorded for it — newest first.
 *
 * Keyed on when the row was typed rather than the batch date it carries, so
 * back-dating a batch never shadows what the user actually filled in most
 * recently. That is what makes a corrected entry win next time round.
 */
export function lastEntryPerItem<T extends ItemEntryLike>(entries: T[]): T[] {
  const latest = new Map<string, T>()

  for (const entry of entries) {
    const key = entry.ingredient.name.trim().toLowerCase()
    if (!key) continue
    const current = latest.get(key)
    if (!current || recordedAt(entry) > recordedAt(current)) latest.set(key, entry)
  }

  return Array.from(latest.values()).sort((left, right) => recordedAt(right) - recordedAt(left))
}

/**
 * The most recently recorded item whose name continues what's been typed.
 *
 * Returns null when nothing matches, and also when the typed text is already
 * the whole name: there is nothing left to complete, and that case is handled
 * by the recorder's exact-match autofill instead.
 */
export function findItemNameCompletion<T extends ItemEntryLike>(
  entries: T[],
  typedName: string,
): { entry: T; itemName: string; remainder: string } | null {
  if (!typedName.trim()) return null

  const typedLower = typedName.toLowerCase()
  const match = lastEntryPerItem(entries).find((entry) => {
    const name = entry.ingredient.name.trim().toLowerCase()
    return name.startsWith(typedLower) && name !== typedLower
  })
  if (!match) return null

  const itemName = match.ingredient.name.trim()
  // Sliced off the stored name so the ghost keeps its saved capitalisation
  // while lining up with however the user typed the prefix.
  return { entry: match, itemName, remainder: itemName.slice(typedName.length) }
}
