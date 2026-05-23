-- Migration: fix_dish_ingredients_inventoryitemid_parity
-- Purpose: older Postgres baselines still expose dish_ingredients.ingredientId,
-- but the runtime and Prisma schema now read and write inventoryItemId.

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