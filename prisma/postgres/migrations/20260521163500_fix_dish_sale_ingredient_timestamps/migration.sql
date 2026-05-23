-- Migration: fix_dish_sale_ingredient_timestamps
-- Purpose: older Postgres baselines created dish_sale_ingredients without the
-- Prisma-managed timestamps required by payment finalization.

ALTER TABLE "dish_sale_ingredients"
ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "dish_sale_ingredients"
ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
