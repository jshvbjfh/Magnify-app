// Item codes (VSDC API §4.17).
//
// `itemCd` is the taxpayer's own code for their own item — distinct from
// `itemClsCd`, which is RRA's classification of what the item is and is chosen
// from their published list rather than generated.
//
// An item code is PERMANENT once issued. It appears on receipts already handed
// to guests and in declarations already filed, so nothing here ever changes a
// code that exists: the planner fills gaps and leaves everything else alone.
//
// PURE: rows in, decisions out. Nothing is read or written.

/** Every code this app issues starts here, so ours are identifiable at a glance. */
export const ITEM_CODE_PREFIX = 'MG'

/** Digits after the prefix. Seven allows ten million items and stays far inside
 *  the twenty characters `itemCd` permits. */
const SEQUENCE_WIDTH = 7

const CODE_PATTERN = new RegExp(`^${ITEM_CODE_PREFIX}(\\d{${SEQUENCE_WIDTH}})$`)

export type CodedItem = {
  id: string
  name: string
  itemCode?: string | null
}

export function formatItemCode(sequence: number): string {
  return `${ITEM_CODE_PREFIX}${String(sequence).padStart(SEQUENCE_WIDTH, '0')}`
}

/**
 * The highest sequence already issued.
 *
 * Only codes this app generated are counted. A venue that imported codes from
 * another system carries those unchanged, and they must not push our sequence
 * — nor be renumbered to fit it.
 */
export function highestIssuedSequence(items: CodedItem[]): number {
  let highest = 0
  for (const item of items) {
    const match = CODE_PATTERN.exec(String(item.itemCode ?? '').trim())
    if (!match) continue
    const value = Number(match[1])
    if (Number.isFinite(value) && value > highest) highest = value
  }
  return highest
}

/**
 * What to assign, for items that have no code at all.
 *
 * Order is the caller's — pass them oldest first and codes follow the order the
 * menu was built in, which is the least surprising thing for whoever reads the
 * list afterwards.
 */
export function nextItemCodes(items: CodedItem[]): Array<{ id: string; name: string; itemCode: string }> {
  let sequence = highestIssuedSequence(items)
  const plan: Array<{ id: string; name: string; itemCode: string }> = []

  for (const item of items) {
    if (String(item.itemCode ?? '').trim()) continue
    sequence += 1
    plan.push({ id: item.id, name: item.name, itemCode: formatItemCode(sequence) })
  }

  return plan
}

export type ItemCodeSummary = {
  total: number
  coded: number
  missing: number
  /** Codes carried by more than one item. Reported, never repaired. */
  duplicates: Array<{ itemCode: string; items: Array<{ id: string; name: string }> }>
  /** Items with no code yet, so a manager can see what a POST would touch. */
  uncoded: Array<{ id: string; name: string }>
  /** True when every item has a code and no code is shared. */
  ready: boolean
  /** One line for the screen, or null when there is nothing to say. */
  concern: string | null
}

/**
 * Coverage and clashes.
 *
 * Duplicates are reported rather than fixed. Renumbering an item to resolve a
 * clash would change a code that may already have been declared, which is the
 * one thing this module never does — a human decides which of the two keeps it.
 */
export function summarizeItemCodes(items: Array<CodedItem & Record<string, unknown>>): ItemCodeSummary {
  const byCode = new Map<string, Array<{ id: string; name: string }>>()
  const uncoded: Array<{ id: string; name: string }> = []

  for (const item of items) {
    const code = String(item.itemCode ?? '').trim()
    if (!code) {
      uncoded.push({ id: item.id, name: item.name })
      continue
    }
    const bucket = byCode.get(code) ?? []
    bucket.push({ id: item.id, name: item.name })
    byCode.set(code, bucket)
  }

  const duplicates = [...byCode.entries()]
    .filter(([, bucket]) => bucket.length > 1)
    .map(([itemCode, bucket]) => ({ itemCode, items: bucket }))

  const coded = items.length - uncoded.length
  const ready = uncoded.length === 0 && duplicates.length === 0

  let concern: string | null = null
  if (duplicates.length > 0) {
    concern = `${duplicates.length} item code(s) are used by more than one item`
  } else if (uncoded.length > 0) {
    concern = `${uncoded.length} item(s) have no code yet`
  }

  return { total: items.length, coded, missing: uncoded.length, duplicates, uncoded, ready, concern }
}
