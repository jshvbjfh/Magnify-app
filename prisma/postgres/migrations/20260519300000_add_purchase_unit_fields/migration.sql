-- Add purchase-unit tracking fields to inventory_purchases.
-- These store the original purchase-side values (e.g. "10 bottles at 2000/bottle")
-- alongside the converted usage-unit values already in quantityPurchased/unitCost.
-- All nullable so existing rows are unaffected.
ALTER TABLE "inventory_purchases" ADD COLUMN IF NOT EXISTS "purchaseQuantity"     DOUBLE PRECISION;
ALTER TABLE "inventory_purchases" ADD COLUMN IF NOT EXISTS "purchaseUnit"         TEXT;
ALTER TABLE "inventory_purchases" ADD COLUMN IF NOT EXISTS "unitsPerPurchaseUnit" DOUBLE PRECISION;
ALTER TABLE "inventory_purchases" ADD COLUMN IF NOT EXISTS "purchaseUnitCost"     DOUBLE PRECISION;
