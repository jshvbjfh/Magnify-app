-- Cleanup: remove dishes and restaurant_tables that cannot be assigned a branchId
-- because they have no restaurantId (truly orphaned) or their restaurant has
-- no active branches (unreachable by any tenant query).
--
-- This runs BEFORE migration 20260429000002 so the NOT NULL constraint can be applied.
-- Safe to run multiple times (idempotent via WHERE conditions).

BEGIN;

-- ── Dishes ────────────────────────────────────────────────────────────────────

-- 1. Delete dishes with no restaurantId (completely orphaned rows)
DELETE FROM "dishes"
WHERE "branchId" IS NULL
  AND "restaurantId" IS NULL;

-- 2. Delete dishes whose restaurant has zero active branches
--    (these are unreachable by every tenant query and cannot be served)
DELETE FROM "dishes" d
WHERE d."branchId" IS NULL
  AND d."restaurantId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "restaurant_branches" rb
    WHERE rb."restaurantId" = d."restaurantId"
      AND rb."isActive" = true
  );

-- ── restaurant_tables ─────────────────────────────────────────────────────────

-- 3. Delete tables with no restaurantId
DELETE FROM "restaurant_tables"
WHERE "branchId" IS NULL
  AND "restaurantId" IS NULL;

-- 4. Delete tables whose restaurant has zero active branches
DELETE FROM "restaurant_tables" t
WHERE t."branchId" IS NULL
  AND t."restaurantId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "restaurant_branches" rb
    WHERE rb."restaurantId" = t."restaurantId"
      AND rb."isActive" = true
  );

COMMIT;
