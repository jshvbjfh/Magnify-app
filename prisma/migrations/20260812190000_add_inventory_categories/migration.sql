-- User-made tabs for grouping stock on the inventory screen. Purely a lens:
-- a category never affects costing, consumption or reporting.
--
-- Nothing is backfilled. The screen reads the tab list as the union of these
-- rows and the category names items already carry, so categories typed before
-- this table existed keep working untouched.
CREATE TABLE IF NOT EXISTS "inventory_categories" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME
);

CREATE UNIQUE INDEX IF NOT EXISTS "inventory_categories_restaurantId_name_key"
    ON "inventory_categories"("restaurantId", "name");

CREATE INDEX IF NOT EXISTS "inventory_categories_restaurantId_idx"
    ON "inventory_categories"("restaurantId");
