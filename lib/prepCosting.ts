import type { Prisma, PrismaClient } from '@prisma/client'

type PrismaDb = PrismaClient | Prisma.TransactionClient

/**
 * A prep's unitCost is a plain stored number, not something FIFO-derived like a
 * purchased item's — nothing computes it automatically. Left alone it defaults
 * to 0 forever, regardless of what its sub-recipe actually costs, which is what
 * made every prep (tomato slice, Caramelized onions, Chili oil, ...) price out
 * at 0 or a stale hand-typed number.
 *
 * This recomputes it as sum(quantityRequired * that ingredient's own current
 * unitCost) across the prep's sub-recipe, and persists the result — so the
 * recipe editor's picker and the reports' cost estimate (both of which just
 * read InventoryItem.unitCost directly) are correct without needing their own
 * changes. Real sales are unaffected either way: they already cascade to raw
 * ingredient FIFO consumption via consumePrepAwareIngredient and never read
 * this field.
 *
 * A sub-recipe ingredient that is itself a prep is priced at ITS current
 * unitCost, which is correct as long as that inner prep was last recalculated
 * after its own sub-recipe last changed — the same guarantee this function
 * provides for whoever calls it. It does not cascade to update preps that use
 * THIS prep as an ingredient; a multi-level prep-of-prep chain needs each
 * level's own edit to trigger its own recalculation.
 */
export async function recalculatePrepUnitCost(db: PrismaDb, prepItemId: string): Promise<number> {
  const rows = await db.prepIngredient.findMany({
    where: { prepItemId },
    select: { quantityRequired: true, ingredient: { select: { unitCost: true } } },
  })

  const unitCost = rows.reduce(
    (sum, row) => sum + Number(row.quantityRequired || 0) * Number(row.ingredient.unitCost ?? 0),
    0,
  )

  await db.inventoryItem.update({
    where: { id: prepItemId },
    data: { unitCost },
  })

  return unitCost
}
