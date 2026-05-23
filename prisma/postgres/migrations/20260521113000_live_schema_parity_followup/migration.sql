-- Migration: live_schema_parity_followup
-- Purpose: close the confirmed Neon drift that blocks fresh-tenant inventory,
-- QR ordering, and Live View reads in the hosted deployment.
-- Safe to re-run: additive columns use IF NOT EXISTS, and legacy NOT NULL drops
-- are guarded by information_schema checks.

-- inventory_items: hosted reads expect deletedAt and hosted writes no longer send userId.
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

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

-- inventory_purchases: the stock-entry flow now scopes purchases by restaurant/branch,
-- so legacy required userId blocks the second write inside the transaction.
ALTER TABLE "inventory_purchases" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

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

-- restaurant_orders: public QR ordering does not populate createdById.
ALTER TABLE "restaurant_orders" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

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

-- dish_sales: hosted reads expect dishName + deletedAt, and paid-order writes no longer send userId.
ALTER TABLE "dish_sales" ADD COLUMN IF NOT EXISTS "dishName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "dish_sales" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

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