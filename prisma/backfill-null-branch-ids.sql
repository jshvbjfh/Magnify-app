-- =============================================================================
-- backfill-null-branch-ids.sql
--
-- PURPOSE
--   Safely assign NULL branchId rows in `dishes` and `restaurant_tables` to
--   the restaurant's actual main branch.  Run this against Neon BEFORE applying
--   the migration that adds the NOT NULL constraint.
--
-- HOW TO RUN
--   npx prisma db execute --url "$DATABASE_URL" --file prisma/backfill-null-branch-ids.sql
--
-- SAFETY
--   All statements are idempotent — safe to re-run if interrupted.
--   No IDs are hardcoded; branch resolution is dynamic per restaurant.
--   Records with restaurantId IS NULL are left untouched (not restaurant-scoped).
-- =============================================================================


-- ── 1. VERIFICATION: inspect what needs fixing ────────────────────────────────

-- How many dishes have null branchId?
SELECT
  COUNT(*)                        AS null_branch_dishes,
  COUNT(DISTINCT "restaurantId")  AS affected_restaurants
FROM "dishes"
WHERE "branchId" IS NULL;

-- How many restaurant_tables have null branchId?
SELECT
  COUNT(*)                        AS null_branch_tables,
  COUNT(DISTINCT "restaurantId")  AS affected_restaurants
FROM "restaurant_tables"
WHERE "branchId" IS NULL;

-- Show impacted restaurants and their current main branch (if any)
SELECT
  d."restaurantId",
  COUNT(d.id)   AS null_branch_dish_count,
  rb.id         AS main_branch_id,
  rb.name       AS main_branch_name,
  rb."isMain"   AS confirmed_main
FROM "dishes" d
LEFT JOIN "restaurant_branches" rb
       ON rb."restaurantId" = d."restaurantId"
      AND rb."isMain" = true
WHERE d."branchId" IS NULL
GROUP BY d."restaurantId", rb.id, rb.name, rb."isMain"
ORDER BY null_branch_dish_count DESC;


-- ── 2. BACKFILL dishes ────────────────────────────────────────────────────────

-- Pass 1: assign the main branch (isMain = true) per restaurant
UPDATE "dishes"
SET "branchId" = rb.id
FROM (
  -- DISTINCT ON keeps only the earliest main branch per restaurant
  SELECT DISTINCT ON ("restaurantId")
    id,
    "restaurantId"
  FROM "restaurant_branches"
  WHERE "isMain" = true
    AND "isActive" = true
  ORDER BY "restaurantId", "createdAt" ASC
) rb
WHERE "dishes"."restaurantId" = rb."restaurantId"
  AND "dishes"."branchId" IS NULL;

-- Pass 2 (safety net): any remaining nulls → earliest active branch
-- Covers restaurants that have no isMain branch (data anomaly)
UPDATE "dishes"
SET "branchId" = rb.id
FROM (
  SELECT DISTINCT ON ("restaurantId")
    id,
    "restaurantId"
  FROM "restaurant_branches"
  WHERE "isActive" = true
  ORDER BY "restaurantId", "sortOrder" ASC, "createdAt" ASC
) rb
WHERE "dishes"."restaurantId" = rb."restaurantId"
  AND "dishes"."branchId" IS NULL;


-- ── 3. BACKFILL restaurant_tables ─────────────────────────────────────────────

-- Pass 1: main branch
UPDATE "restaurant_tables"
SET "branchId" = rb.id
FROM (
  SELECT DISTINCT ON ("restaurantId")
    id,
    "restaurantId"
  FROM "restaurant_branches"
  WHERE "isMain" = true
    AND "isActive" = true
  ORDER BY "restaurantId", "createdAt" ASC
) rb
WHERE "restaurant_tables"."restaurantId" = rb."restaurantId"
  AND "restaurant_tables"."branchId" IS NULL;

-- Pass 2 (safety net): any active branch
UPDATE "restaurant_tables"
SET "branchId" = rb.id
FROM (
  SELECT DISTINCT ON ("restaurantId")
    id,
    "restaurantId"
  FROM "restaurant_branches"
  WHERE "isActive" = true
  ORDER BY "restaurantId", "sortOrder" ASC, "createdAt" ASC
) rb
WHERE "restaurant_tables"."restaurantId" = rb."restaurantId"
  AND "restaurant_tables"."branchId" IS NULL;


-- ── 4. POST-BACKFILL VERIFICATION ─────────────────────────────────────────────

-- These counts should both be 0 after the backfill
SELECT 'dishes remaining with null branchId' AS check_name, COUNT(*) AS remaining
FROM "dishes"
WHERE "branchId" IS NULL
UNION ALL
SELECT 'restaurant_tables remaining with null branchId', COUNT(*)
FROM "restaurant_tables"
WHERE "branchId" IS NULL;

-- Confirm backfilled branch IDs actually exist in restaurant_branches
SELECT
  d."branchId",
  rb.id AS branch_record_found
FROM "dishes" d
LEFT JOIN "restaurant_branches" rb ON rb.id = d."branchId"
WHERE rb.id IS NULL
  AND d."branchId" IS NOT NULL
LIMIT 20;
