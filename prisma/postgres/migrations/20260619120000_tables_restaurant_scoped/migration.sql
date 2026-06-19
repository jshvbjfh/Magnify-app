-- Tables are now restaurant-wide: every branch shares one floor plan.
-- Collapse any same-name duplicates across branches into a single row per
-- (restaurantId, name), keeping the earliest-created row, then switch the
-- per-branch unique index for a per-restaurant one. Idempotent + drift-safe.

-- 1) Repoint restaurant_orders to the surviving (earliest) table per name.
UPDATE "restaurant_orders" o
SET "tableId" = (
  SELECT s.id FROM "restaurant_tables" s
  WHERE s."restaurantId" = t."restaurantId" AND s."name" = t."name"
  ORDER BY s."createdAt" ASC, s.id ASC
  LIMIT 1
)
FROM "restaurant_tables" t
WHERE o."tableId" = t.id;

-- 2) Repoint pending_orders the same way (Postgres-only table).
UPDATE "pending_orders" p
SET "tableId" = (
  SELECT s.id FROM "restaurant_tables" s
  WHERE s."restaurantId" = t."restaurantId" AND s."name" = t."name"
  ORDER BY s."createdAt" ASC, s.id ASC
  LIMIT 1
)
FROM "restaurant_tables" t
WHERE p."tableId" = t.id;

-- 3) Occupied-wins: if any same-name row is occupied, the survivor is occupied.
UPDATE "restaurant_tables" t
SET "status" = 'occupied'
WHERE EXISTS (
  SELECT 1 FROM "restaurant_tables" d
  WHERE d."restaurantId" = t."restaurantId" AND d."name" = t."name" AND d."status" = 'occupied'
);

-- 4) Delete the non-surviving duplicate rows (keep earliest createdAt per name).
DELETE FROM "restaurant_tables" t
WHERE t.id NOT IN (
  SELECT DISTINCT ON ("restaurantId", "name") id
  FROM "restaurant_tables"
  ORDER BY "restaurantId", "name", "createdAt" ASC, id ASC
);

-- 5) Swap the per-branch unique index/constraint for a per-restaurant one.
ALTER TABLE "restaurant_tables" DROP CONSTRAINT IF EXISTS "restaurant_tables_branchId_name_key";
DROP INDEX IF EXISTS "restaurant_tables_branchId_name_key";
CREATE UNIQUE INDEX IF NOT EXISTS "restaurant_tables_restaurantId_name_key" ON "restaurant_tables"("restaurantId", "name");
