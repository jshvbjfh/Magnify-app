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
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "qrMenuHeroImageUrl" TEXT;
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "deletedAt"  TIMESTAMP;
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "isActive"   BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "branches" ADD COLUMN IF NOT EXISTS "isMain"     BOOLEAN NOT NULL DEFAULT false;

-- staff
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP;
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "phone"     TEXT;
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "pin"       TEXT;
ALTER TABLE "staff" ADD COLUMN IF NOT EXISTS "username"  TEXT;

-- dishes
ALTER TABLE "dishes" ADD COLUMN IF NOT EXISTS "menuType"    TEXT;
ALTER TABLE "dishes" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "dishes" ADD COLUMN IF NOT EXISTS "deletedAt"   TIMESTAMP;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'dishes'
      AND column_name = 'userId'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "dishes" ALTER COLUMN "userId" DROP NOT NULL;
  END IF;
END $$;

-- dish_ingredients
DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'dish_ingredients'
      AND column_name = 'ingredientId'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'dish_ingredients'
      AND column_name = 'inventoryItemId'
  ) THEN
    ALTER TABLE "dish_ingredients" RENAME COLUMN "ingredientId" TO "inventoryItemId";
  END IF;
END $$;
ALTER TABLE "dish_ingredients" ADD COLUMN IF NOT EXISTS "unit"      TEXT;
ALTER TABLE "dish_ingredients" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "dish_ingredients" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- restaurant_tables
ALTER TABLE "restaurant_tables" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP;

-- inventory_items: drop old (userId, name) unique index replaced by (restaurantId, branchId, name)
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "restaurantId" TEXT;
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "branchId"    TEXT;
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "deletedAt"   TIMESTAMP;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'inventory_items'
      AND column_name = 'userId'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "inventory_items" ALTER COLUMN "userId" DROP NOT NULL;
  END IF;
END $$;
DROP INDEX IF EXISTS "inventory_items_userId_name_key";
CREATE UNIQUE INDEX IF NOT EXISTS "inventory_items_restaurantId_branchId_name_key"
  ON "inventory_items" ("restaurantId", "branchId", "name")
  WHERE "restaurantId" IS NOT NULL AND "branchId" IS NOT NULL;

-- inventory_purchases
ALTER TABLE "inventory_purchases" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'inventory_purchases'
      AND column_name = 'userId'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "inventory_purchases" ALTER COLUMN "userId" DROP NOT NULL;
  END IF;
END $$;

-- restaurant_orders
ALTER TABLE "restaurant_orders" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP;
DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'restaurant_orders'
      AND column_name = 'createdById'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "restaurant_orders" ALTER COLUMN "createdById" DROP NOT NULL;
  END IF;
END $$;

-- dish_sales
ALTER TABLE "dish_sales" ADD COLUMN IF NOT EXISTS "dishName"       TEXT NOT NULL DEFAULT '';
ALTER TABLE "dish_sales" ADD COLUMN IF NOT EXISTS "dishVariantId"  TEXT;
ALTER TABLE "dish_sales" ADD COLUMN IF NOT EXISTS "dishVariantName" TEXT;
ALTER TABLE "dish_sales" ADD COLUMN IF NOT EXISTS "orderItemId"    TEXT;
ALTER TABLE "dish_sales" ADD COLUMN IF NOT EXISTS "deletedAt"      TIMESTAMP;
CREATE INDEX IF NOT EXISTS "dish_sales_orderItemId_idx" ON "dish_sales" ("orderItemId");
DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'dish_sales'
      AND column_name = 'userId'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "dish_sales" ALTER COLUMN "userId" DROP NOT NULL;
  END IF;
END $$;

-- order_items: variant snapshot columns
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "dishVariantId"   TEXT;
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "dishVariantName" TEXT;

-- restaurants: QR ordering mode
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "qrOrderingMode" TEXT NOT NULL DEFAULT 'order';

-- dish_variants table (entire table — created if missing)
CREATE TABLE IF NOT EXISTS "dish_variants" (
  "id"           TEXT        NOT NULL PRIMARY KEY,
  "dishId"       TEXT        NOT NULL REFERENCES "dishes"("id") ON DELETE CASCADE,
  "name"         TEXT        NOT NULL,
  "sellingPrice" DOUBLE PRECISION NOT NULL,
  "sortOrder"    INTEGER     NOT NULL DEFAULT 0,
  "isActive"     BOOLEAN     NOT NULL DEFAULT true,
  "createdAt"    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deletedAt"    TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "dish_variants_dishId_name_key" ON "dish_variants" ("dishId", "name");
CREATE INDEX IF NOT EXISTS "dish_variants_dishId_sortOrder_isActive_idx" ON "dish_variants" ("dishId", "sortOrder", "isActive");
