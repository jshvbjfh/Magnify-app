-- Tables are now restaurant-wide: every branch shares one floor plan.
-- Collapse any same-name duplicates across branches into a single row per
-- (restaurantId, name), keeping the earliest-created row, then switch the
-- per-branch unique index for a per-restaurant one. Idempotent + drift-safe.

-- 1) Repoint orders from duplicate tables to the surviving (earliest) table.
UPDATE "restaurant_orders"
SET "tableId" = (
  SELECT s."id" FROM "restaurant_tables" s
  JOIN "restaurant_tables" t ON t."id" = "restaurant_orders"."tableId"
  WHERE s."restaurantId" = t."restaurantId" AND s."name" = t."name"
  ORDER BY s."rowid" ASC
  LIMIT 1
)
WHERE "tableId" IS NOT NULL
  AND "tableId" IN (SELECT "id" FROM "restaurant_tables");

-- 2) Occupied-wins: if any same-name row is occupied, the survivor is occupied.
UPDATE "restaurant_tables"
SET "status" = 'occupied'
WHERE EXISTS (
  SELECT 1 FROM "restaurant_tables" d
  WHERE d."restaurantId" = "restaurant_tables"."restaurantId"
    AND d."name" = "restaurant_tables"."name"
    AND d."status" = 'occupied'
);

-- 3) Delete the non-surviving duplicate rows (keep earliest rowid per name).
DELETE FROM "restaurant_tables"
WHERE "rowid" NOT IN (
  SELECT MIN("rowid") FROM "restaurant_tables" GROUP BY "restaurantId", "name"
);

-- 4) Swap the per-branch unique index for a per-restaurant one.
DROP INDEX IF EXISTS "restaurant_tables_branchId_name_key";
CREATE UNIQUE INDEX IF NOT EXISTS "restaurant_tables_restaurantId_name_key" ON "restaurant_tables"("restaurantId", "name");
