-- Add all columns that exist in the Prisma schema but may be missing from Neon.
-- All statements use IF NOT EXISTS / safe defaults so this is safe to re-run.

-- restaurants
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "deletedAt"        TIMESTAMP;
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "managerId"        TEXT;
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "billHeader"       TEXT;
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "licenseExpiry"    TIMESTAMP;
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "licenseActive"    BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "fifoEnabled"      BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "fifoConfiguredAt" TIMESTAMP;
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "syncRestaurantId" TEXT;

-- branches
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "address"    TEXT;
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "billHeader" TEXT;
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "deletedAt"  TIMESTAMP;
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "isActive"   BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "isMain"     BOOLEAN NOT NULL DEFAULT false;

-- staff
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP;
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "phone"     TEXT;
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "pin"       TEXT;
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "username"  TEXT;

-- restaurant_tables
ALTER TABLE "restaurant_tables" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP;

-- inventory_items: drop old (userId, name) unique index replaced by (restaurantId, branchId, name)
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "restaurantId" TEXT;
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "branchId"    TEXT;
DROP INDEX IF EXISTS "inventory_items_userId_name_key";
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_items_restaurantId_branchId_name_key"
  ON "inventory_items" ("restaurantId", "branchId", "name")
  WHERE "restaurantId" IS NOT NULL AND "branchId" IS NOT NULL;
