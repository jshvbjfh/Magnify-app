// How many of a dish the stock will actually support.
//
// lib/fiscalStockGuard decides whether a line may be sold (§7.30); it is handed
// an `available` figure and does not work one out. This is where that figure
// comes from.
//
// ── Why `undefined` is a real answer here ───────────────────────────────────
//
// The guard treats undefined as UNKNOWN and lets the sale through, which is
// deliberate: a venue part-way through building its recipes must not have every
// dish refused. So this returns undefined wherever the stock genuinely cannot
// be known, and a number only where it can. Returning 0 for "no recipe" would
// close the restaurant.
//
// PURE: quantities in, a count out. Nothing is read.

/** One line of a dish's recipe. */
export type RecipeLine = {
  inventoryItemId: string
  quantityRequired: number
}

export type DishAvailabilityInput = {
  /** GOODS or SERVICE — see Dish.itemType. */
  itemType?: string | null
  /** Batch-cooked portions already made and waiting (MEP). */
  preparedPortions?: number | null
  recipe: RecipeLine[]
  /** On-hand quantity per inventory item id. */
  onHand: Map<string, number>
}

/**
 * How many portions can be served, or undefined when that cannot be known.
 *
 * Undefined for a dish with no recipe — nothing links it to countable stock, so
 * there is no figure to give. The guard exempts services anyway, but this
 * returns a number for them where it can, because the same figure is worth
 * showing on screen whether or not it blocks a sale.
 */
export function dishAvailability(input: DishAvailabilityInput): number | undefined {
  const prepared = Math.max(0, Number(input.preparedPortions ?? 0))

  const usable = input.recipe.filter((line) => Number(line.quantityRequired) > 0)

  if (usable.length === 0) {
    // No recipe at all. Prepared portions are still a countable thing, so a
    // dish with MEP on hand and no recipe reports what it has; one with
    // neither reports unknown rather than zero.
    return prepared > 0 ? prepared : undefined
  }

  let limit = Infinity
  for (const line of usable) {
    const onHand = Number(input.onHand.get(line.inventoryItemId) ?? 0)
    // Whole portions only: half a bottle of beer is not a serving.
    const possible = Math.floor(onHand / Number(line.quantityRequired))
    if (possible < limit) limit = possible
  }

  if (!Number.isFinite(limit)) return undefined

  // Portions already cooked are additional to what the raw stock supports:
  // their ingredients have already left the store.
  return Math.max(0, limit) + prepared
}

/**
 * Availability for many dishes at once.
 *
 * Takes the recipes grouped by dish so a caller can load them in one query
 * rather than one per dish — the difference between one round trip and thirty
 * on a busy bill.
 */
export function availabilityByDish(
  dishes: Array<{ id: string; itemType?: string | null; preparedPortions?: number | null }>,
  recipesByDishId: Map<string, RecipeLine[]>,
  onHand: Map<string, number>,
): Map<string, number | undefined> {
  const result = new Map<string, number | undefined>()
  for (const dish of dishes) {
    result.set(
      dish.id,
      dishAvailability({
        itemType: dish.itemType,
        preparedPortions: dish.preparedPortions,
        recipe: recipesByDishId.get(dish.id) ?? [],
        onHand,
      }),
    )
  }
  return result
}
