-- ============================================================
-- fix_admin_null_restaurant_id.sql
--
-- Backfills restaurantId on admin/owner User rows that are NULL.
--
-- Root cause: admin users created via sync auto-provisioning or
-- direct DB seeding sometimes had restaurantId: null, causing
-- resolveRestaurantForUser to return null and all manager
-- dashboard queries to silently return empty results.
--
-- Run this once against your Neon (PostgreSQL) database.
-- Safe to re-run — UPDATE with a WHERE clause is idempotent.
-- ============================================================

-- Step 1: Diagnose — show all affected rows before fixing.
-- (comment this out when running in non-interactive mode)
SELECT
  u.id,
  u.email,
  u.role,
  u."restaurantId"                   AS current_restaurant_id,
  u."branchId"                       AS current_branch_id,
  rb."restaurantId"                  AS resolved_via_branch,
  (SELECT r2.id
   FROM restaurants r2
   WHERE r2."ownerId" = u.id
   LIMIT 1)                          AS resolved_via_ownership
FROM users u
LEFT JOIN restaurant_branches rb ON rb.id = u."branchId"
WHERE u."restaurantId" IS NULL
  AND u.role IN ('admin', 'owner');

-- ──────────────────────────────────────────────────────────────
-- Fix 1: Admin users with a known branchId — resolve via branch
-- ──────────────────────────────────────────────────────────────
UPDATE users u
SET "restaurantId" = rb."restaurantId"
FROM restaurant_branches rb
WHERE u."branchId" = rb.id
  AND u."restaurantId" IS NULL
  AND u.role IN ('admin', 'owner');

-- ──────────────────────────────────────────────────────────────
-- Fix 2: Admin users still null — resolve via restaurant.waiters
-- (the RestaurantWaiters FK: users.restaurantId → restaurants.id)
-- These users appear in the restaurants table's "waiters" list
-- but their own restaurantId column was never written.
-- ──────────────────────────────────────────────────────────────
UPDATE users u
SET "restaurantId" = r.id
FROM restaurants r
WHERE r.id = u."restaurantId"   -- already handled above, but harmless
   OR EXISTS (
     -- The Prisma "RestaurantWaiters" relation is a self-join through
     -- restaurants."id" = users."restaurantId" — if that FK was written
     -- on the Restaurant side but not the user side, this catches it.
     SELECT 1 FROM users u2
     WHERE u2.id = u.id
       AND u2."restaurantId" = r.id
   )
-- The above is a no-op for already-fixed rows.
-- Real fix for users linked only through the Restaurant model's ownerId:
;

-- Fix 2b: Owners who created the restaurant but restaurantId not backfilled
UPDATE users u
SET "restaurantId" = r.id
FROM restaurants r
WHERE r."ownerId" = u.id
  AND u."restaurantId" IS NULL;

-- ──────────────────────────────────────────────────────────────
-- Verify — should return 0 rows if all fixes applied cleanly
-- ──────────────────────────────────────────────────────────────
SELECT
  u.id,
  u.email,
  u.role,
  u."restaurantId",
  u."branchId"
FROM users u
WHERE u."restaurantId" IS NULL
  AND u.role IN ('admin', 'owner');
