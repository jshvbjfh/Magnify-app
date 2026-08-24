export const MENU_TYPE_OPTIONS = [
  { value: 'mains', label: 'Mains' },
  { value: 'sides', label: 'Sides' },
  { value: 'drinks', label: 'Drinks' },
] as const

export const MENU_TYPE_SECTION_ORDER = ['mains', 'sides', 'drinks', 'other'] as const

export type MenuTypeValue = (typeof MENU_TYPE_OPTIONS)[number]['value']

export const DEFAULT_MENU_CATEGORY_SUGGESTIONS = [
  'Pizzas',
  'Burgers',
  'Soft Drinks',
  'Hot Drinks',
  'Liquors',
  'Desserts',
  'Breakfast',
  'Add-ons',
] as const

function normalizeText(value?: string | null) {
  return String(value ?? '').trim().toLowerCase()
}

// Add-ons (extra sauce, extra topping, etc.) are meant to be orderable at
// every station, not just the branch a manager happened to be viewing when
// they created the dish — so dish creation fans this category out to all
// branches instead of the usual single-branch row.
export function isAddonCategory(category?: string | null) {
  return /add[\s-]?ons?/i.test(String(category ?? ''))
}

export function normalizeDishMenuType(value?: string | null): MenuTypeValue | null {
  const normalized = normalizeText(value)
  if (!normalized) return null
  if (normalized === 'main' || normalized === 'mains') return 'mains'
  if (normalized === 'side' || normalized === 'sides') return 'sides'
  if (normalized === 'drink' || normalized === 'drinks') return 'drinks'
  return null
}

export function resolveDishMenuType(value?: string | null, category?: string | null): MenuTypeValue | null {
  const explicitType = normalizeDishMenuType(value)
  if (explicitType) return explicitType

  const legacyCategoryType = normalizeDishMenuType(category)
  if (legacyCategoryType) return legacyCategoryType

  return null
}

export function getDishMenuTypeLabel(value?: string | null, category?: string | null) {
  const resolvedType = resolveDishMenuType(value, category)
  return MENU_TYPE_OPTIONS.find((option) => option.value === resolvedType)?.label ?? null
}

export function getDishMenuTypeKey(value?: string | null, category?: string | null) {
  return resolveDishMenuType(value, category) ?? 'other'
}

/**
 * The grouping key for a free-typed menu category.
 *
 * Category is typed by hand, so one real category reaches the database under
 * several spellings and every report that groups on the raw text splits it into
 * several rows. On the live menu "Mains dish", "Main Dish" and "Mains Dish" are
 * three rows covering 35 dishes, and "Starters / Meze", "Starters/meze" and
 * "Starters/Meze" another three covering 22 — a manager reading either report
 * sees a third of the real total and no hint that the rest exists.
 *
 * Case, punctuation, spacing and a trailing plural all get folded, which
 * collapses 37 categories to 32 on the current menu. Genuine typos survive it
 * ("Mains dishe" stays apart from "Mains dish") — this is a read-side
 * workaround, not a substitute for fixing the menu.
 *
 * Group on this; show the spelling staff actually use, never this key.
 */
export function categoryGroupKey(raw?: string | null): string {
  return String(raw ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word))
    .join(' ')
}