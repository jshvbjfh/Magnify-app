-- Migration: enforce_dish_table_branch_not_null
-- Neon Postgres track
--
-- STEP ORDER (must not be reversed):
--   1. Backfill null branchIds → avoids NOT NULL violation
--   2. ALTER TABLE → enforce the constraint
--   3. CREATE INDEX → cover the pull query pattern
--
-- Run AFTER backfill-null-branch-ids.sql confirms 0 remaining nulls,
-- OR let this migration do the backfill itself (it includes both).

BEGIN;

-- ── 1. Backfill any remaining NULL branchIds on dishes ────────────────────────

-- Primary: isMain branch
UPDATE "dishes"
SET "branchId" = rb.id
FROM (
  SELECT DISTINCT ON ("restaurantId") id, "restaurantId"
  FROM "restaurant_branches"
  WHERE "isMain" = true AND "isActive" = true
  ORDER BY "restaurantId", "createdAt" ASC
) rb
WHERE "dishes"."restaurantId" = rb."restaurantId"
  AND "dishes"."branchId" IS NULL;

-- Safety net: any active branch
UPDATE "dishes"
SET "branchId" = rb.id
FROM (
  SELECT DISTINCT ON ("restaurantId") id, "restaurantId"
  FROM "restaurant_branches"
  WHERE "isActive" = true
  ORDER BY "restaurantId", "sortOrder" ASC, "createdAt" ASC
) rb
WHERE "dishes"."restaurantId" = rb."restaurantId"
  AND "dishes"."branchId" IS NULL;

-- ── 2. Backfill any remaining NULL branchIds on restaurant_tables ──────────────

UPDATE "restaurant_tables"
SET "branchId" = rb.id
FROM (
  SELECT DISTINCT ON ("restaurantId") id, "restaurantId"
  FROM "restaurant_branches"
  WHERE "isMain" = true AND "isActive" = true
  ORDER BY "restaurantId", "createdAt" ASC
) rb
WHERE "restaurant_tables"."restaurantId" = rb."restaurantId"
  AND "restaurant_tables"."branchId" IS NULL;

UPDATE "restaurant_tables"
SET "branchId" = rb.id
FROM (
  SELECT DISTINCT ON ("restaurantId") id, "restaurantId"
  FROM "restaurant_branches"
  WHERE "isActive" = true
  ORDER BY "restaurantId", "sortOrder" ASC, "createdAt" ASC
) rb
WHERE "restaurant_tables"."restaurantId" = rb."restaurantId"
  AND "restaurant_tables"."branchId" IS NULL;

-- ── 3. Validate: abort the migration if any nulls remain ──────────────────────
-- (Postgres will raise if the count <> 0)
DO $$
DECLARE
  dish_nulls   INTEGER;
  table_nulls  INTEGER;
BEGIN
  SELECT COUNT(*) INTO dish_nulls  FROM "dishes"            WHERE "branchId" IS NULL;
  SELECT COUNT(*) INTO table_nulls FROM "restaurant_tables" WHERE "branchId" IS NULL;

  IF dish_nulls > 0 THEN
    RAISE EXCEPTION 'Migration aborted: % dish row(s) still have NULL branchId after backfill. '
      'These rows have no restaurantId and must be investigated manually.',
      dish_nulls;
  END IF;

  IF table_nulls > 0 THEN
    RAISE EXCEPTION 'Migration aborted: % restaurant_table row(s) still have NULL branchId after backfill. '
      'These rows have no restaurantId and must be investigated manually.',
      table_nulls;
  END IF;
END $$;

-- ── 4. Enforce NOT NULL ────────────────────────────────────────────────────────

ALTER TABLE "dishes"            ALTER COLUMN "branchId" SET NOT NULL;
ALTER TABLE "restaurant_tables" ALTER COLUMN "branchId" SET NOT NULL;

-- ── 5. Add composite indexes (cover the mobile pull query pattern) ─────────────
-- dishes: WHERE restaurantId = ? AND (branchId = ? OR branchId IS NULL) AND isActive = true
-- After NOT NULL enforcement the IS NULL arm is eliminated; index still optimal.

CREATE INDEX IF NOT EXISTS "dishes_restaurantId_branchId_isActive_idx"
  ON "dishes" ("restaurantId", "branchId", "isActive");

-- restaurant_tables: WHERE restaurantId = ? AND (branchId = ? OR branchId IS NULL)
CREATE INDEX IF NOT EXISTS "restaurant_tables_restaurantId_branchId_idx"
  ON "restaurant_tables" ("restaurantId", "branchId");

COMMIT;
