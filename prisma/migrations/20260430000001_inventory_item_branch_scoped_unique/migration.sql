-- Migration: inventory_item_and_dish_branch_scoped_unique
-- SQLite track (Electron desktop local database)
--
-- Problem: @@unique([userId, name]) on inventory_items and dishes prevents the
-- same ingredient/dish name from existing in two different branches under the
-- same user. The sync engine's C1 conflict resolution incorrectly merges rows
-- that share the same name but belong to different branches or restaurants.
--
-- Fix: Change both unique constraints to @@unique([userId, restaurantId, branchId, name])
-- so that each (user, restaurant, branch) triple has its own namespace. This
-- matches what the PostgreSQL migration track (20260421173000) already applied.
--
-- Strategy:
--   1. Backfill NULL branchId rows using the restaurant's main branch.
--   2. Drop the old (userId, name) unique indexes.
--   3. Create new (userId, restaurantId, branchId, name) unique indexes.

-- ── 1. Backfill NULL branchIds on inventory_items ─────────────────────────────

-- Primary: use the restaurant's isMain branch
UPDATE "inventory_items"
SET "branchId" = (
	SELECT rb."id"
	FROM "restaurant_branches" rb
	WHERE rb."restaurantId" = "inventory_items"."restaurantId"
	  AND rb."isMain" = 1
	  AND rb."isActive" = 1
	ORDER BY rb."createdAt" ASC
	LIMIT 1
)
WHERE "branchId" IS NULL
  AND "restaurantId" IS NOT NULL;

-- Safety net: any active branch for restaurants with no main branch
UPDATE "inventory_items"
SET "branchId" = (
	SELECT rb."id"
	FROM "restaurant_branches" rb
	WHERE rb."restaurantId" = "inventory_items"."restaurantId"
	  AND rb."isActive" = 1
	ORDER BY rb."sortOrder" ASC, rb."createdAt" ASC
	LIMIT 1
)
WHERE "branchId" IS NULL
  AND "restaurantId" IS NOT NULL;

-- ── 2. Drop old unique index on inventory_items ──────────────────────────────────

DROP INDEX IF EXISTS "inventory_items_userId_name_key";

-- ── 3. Create new (userId, restaurantId, branchId, name) unique index on inventory_items ─
--    Matches: prisma/postgres/migrations/20260421173000_add_restaurant_branch_foundation

CREATE UNIQUE INDEX "inventory_items_userId_restaurantId_branchId_name_key"
  ON "inventory_items"("userId", "restaurantId", "branchId", "name");

-- ── 4. Backfill NULL branchIds on dishes ──────────────────────────────────────
--    dishes already had branchId NOT NULL enforced by migration 20260429000002,
--    but users running migrations in order may still have NULL rows from before
--    that migration ran. This is a safety net only.

UPDATE "dishes"
SET "branchId" = (
	SELECT rb."id"
	FROM "restaurant_branches" rb
	WHERE rb."restaurantId" = "dishes"."restaurantId"
	  AND rb."isMain" = 1
	  AND rb."isActive" = 1
	ORDER BY rb."createdAt" ASC
	LIMIT 1
)
WHERE "branchId" IS NULL
  AND "restaurantId" IS NOT NULL;

UPDATE "dishes"
SET "branchId" = (
	SELECT rb."id"
	FROM "restaurant_branches" rb
	WHERE rb."restaurantId" = "dishes"."restaurantId"
	  AND rb."isActive" = 1
	ORDER BY rb."sortOrder" ASC, rb."createdAt" ASC
	LIMIT 1
)
WHERE "branchId" IS NULL
  AND "restaurantId" IS NOT NULL;

-- ── 5. Drop old unique index on dishes ────────────────────────────────────────

DROP INDEX IF EXISTS "dishes_userId_name_key";

-- ── 6. Create new (userId, restaurantId, branchId, name) unique index on dishes ─
--    Matches: prisma/postgres/migrations/20260421173000_add_restaurant_branch_foundation

CREATE UNIQUE INDEX "dishes_userId_restaurantId_branchId_name_key"
  ON "dishes"("userId", "restaurantId", "branchId", "name");
