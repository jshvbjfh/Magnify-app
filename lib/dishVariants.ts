export type DishVariantRecord = {
  id: string
  name: string
  sellingPrice: number
  sortOrder?: number | null
  isActive?: boolean | null
}

type DishVariantPayload = {
  id?: string | null
  name?: string | null
  sellingPrice?: number | string | null
  sortOrder?: number | string | null
  isActive?: boolean | null
}

export type NormalizedDishVariant = {
  id?: string
  name: string
  sellingPrice: number
  sortOrder: number
  isActive: boolean
}

export function getActiveDishVariants<T extends DishVariantRecord>(variants: T[] | null | undefined): T[] {
  if (!Array.isArray(variants)) return []
  return [...variants]
    .filter((variant) => variant && variant.isActive !== false)
    .sort((left, right) => {
      const leftOrder = Number(left.sortOrder ?? 0)
      const rightOrder = Number(right.sortOrder ?? 0)
      if (leftOrder !== rightOrder) return leftOrder - rightOrder
      return left.name.localeCompare(right.name)
    })
}

export function getDishStartingPrice(variants: DishVariantRecord[] | null | undefined, fallbackPrice: number) {
  const activeVariants = getActiveDishVariants(variants)
  if (activeVariants.length === 0) return Number(fallbackPrice)
  return Math.min(...activeVariants.map((variant) => Number(variant.sellingPrice)))
}

export function buildDishVariantLabel(dishName: string, variantName?: string | null) {
  const normalizedVariantName = String(variantName ?? '').trim()
  return normalizedVariantName ? `${dishName} - ${normalizedVariantName}` : dishName
}

export function normalizeDishVariantPayload(input: unknown): NormalizedDishVariant[] {
  if (!Array.isArray(input)) return []

  const seenNames = new Set<string>()
  const normalized: NormalizedDishVariant[] = []

  for (const [index, rawVariant] of input.entries()) {
    const variant = (rawVariant ?? {}) as DishVariantPayload
    const name = String(variant.name ?? '').trim()
    const sellingPrice = Number(variant.sellingPrice)

    if (!name || !Number.isFinite(sellingPrice) || sellingPrice < 0) {
      continue
    }

    const normalizedNameKey = name.toLowerCase()
    if (seenNames.has(normalizedNameKey)) {
      continue
    }
    seenNames.add(normalizedNameKey)

    const id = String(variant.id ?? '').trim()
    const sortOrder = Number(variant.sortOrder)

    normalized.push({
      ...(id ? { id } : {}),
      name,
      sellingPrice,
      sortOrder: Number.isFinite(sortOrder) ? sortOrder : index,
      isActive: variant.isActive !== false,
    })
  }

  return normalized
}