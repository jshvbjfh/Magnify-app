-- Migration: fix_dish_ingredients_missing_fields
-- Purpose: older Postgres baselines created dish_ingredients without the
-- optional unit column and the Prisma-managed timestamps now read by runtime queries.

ALTER TABLE "dish_ingredients" ADD COLUMN IF NOT EXISTS "unit" TEXT;
ALTER TABLE "dish_ingredients" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "dish_ingredients" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;