-- Migration: enforce_dish_table_branch_not_null
-- SQLite track (Electron desktop local database)
--
-- SQLite does not support ALTER COLUMN ... NOT NULL.
-- Strategy:
--   1. Backfill any NULL branchId rows using the restaurant's main branch
--   2. Recreate `dishes` and `restaurant_tables` with branchId NOT NULL
--   3. Add composite indexes for the waiter pull query pattern
--
-- NOTE: PRAGMA foreign_keys=OFF is required during table recreation.
--       It is re-enabled at the end of this migration.

PRAGMA foreign_keys=OFF;

-- ── 1. Backfill NULL branchIds on dishes ──────────────────────────────────────

-- Primary: use the restaurant's isMain branch
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

-- Safety net: any active branch for restaurants with no main branch
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

-- ── 2. Backfill NULL branchIds on restaurant_tables ───────────────────────────

UPDATE "restaurant_tables"
SET "branchId" = (
	SELECT rb."id"
	FROM "restaurant_branches" rb
	WHERE rb."restaurantId" = "restaurant_tables"."restaurantId"
	  AND rb."isMain" = 1
	  AND rb."isActive" = 1
	ORDER BY rb."createdAt" ASC
	LIMIT 1
)
WHERE "branchId" IS NULL
  AND "restaurantId" IS NOT NULL;

UPDATE "restaurant_tables"
SET "branchId" = (
	SELECT rb."id"
	FROM "restaurant_branches" rb
	WHERE rb."restaurantId" = "restaurant_tables"."restaurantId"
	  AND rb."isActive" = 1
	ORDER BY rb."sortOrder" ASC, rb."createdAt" ASC
	LIMIT 1
)
WHERE "branchId" IS NULL
  AND "restaurantId" IS NOT NULL;

-- ── 3. Recreate dishes with branchId NOT NULL ─────────────────────────────────

CREATE TABLE "_new_dishes" (
	"id"           TEXT     NOT NULL PRIMARY KEY,
	"userId"       TEXT     NOT NULL,
	"name"         TEXT     NOT NULL,
	"sellingPrice" REAL     NOT NULL,
	"category"     TEXT,
	"isActive"     BOOLEAN  NOT NULL DEFAULT true,
	"createdAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updatedAt"    DATETIME NOT NULL,
	"restaurantId" TEXT,
	"branchId"     TEXT     NOT NULL,
	CONSTRAINT "_new_dishes_userId_fkey"
		FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Copy only rows that have a branchId (null rows were backfilled above;
-- any remaining null rows have no restaurantId and are truly orphaned).
INSERT INTO "_new_dishes"
SELECT
	"id", "userId", "name", "sellingPrice", "category", "isActive",
	"createdAt", "updatedAt", "restaurantId", "branchId"
FROM "dishes"
WHERE "branchId" IS NOT NULL;

DROP TABLE "dishes";
ALTER TABLE "_new_dishes" RENAME TO "dishes";

-- Restore unique constraint
CREATE UNIQUE INDEX "dishes_userId_name_key" ON "dishes"("userId", "name");

-- New composite index for the waiter pull query
CREATE INDEX "dishes_restaurantId_branchId_isActive_idx"
  ON "dishes"("restaurantId", "branchId", "isActive");

-- ── 4. Recreate restaurant_tables with branchId NOT NULL ──────────────────────

CREATE TABLE "_new_restaurant_tables" (
	"id"           TEXT     NOT NULL PRIMARY KEY,
	"restaurantId" TEXT     NOT NULL,
	"name"         TEXT     NOT NULL,
	"seats"        INTEGER  NOT NULL DEFAULT 4,
	"status"       TEXT     NOT NULL DEFAULT 'available',
	"createdAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	"updatedAt"    DATETIME NOT NULL,
	"branchId"     TEXT     NOT NULL,
	CONSTRAINT "_new_restaurant_tables_restaurantId_fkey"
		FOREIGN KEY ("restaurantId") REFERENCES "restaurants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "_new_restaurant_tables"
SELECT "id", "restaurantId", "name", "seats", "status", "createdAt", "updatedAt", "branchId"
FROM "restaurant_tables"
WHERE "branchId" IS NOT NULL;

DROP TABLE "restaurant_tables";
ALTER TABLE "_new_restaurant_tables" RENAME TO "restaurant_tables";

-- New composite index for the waiter pull query
CREATE INDEX "restaurant_tables_restaurantId_branchId_idx"
  ON "restaurant_tables"("restaurantId", "branchId");

PRAGMA foreign_keys=ON;
