-- Optional expiry date for a stock batch. The user may skip it, so null means
-- "no expiry tracked" and must never be read as an expiry of today.
ALTER TABLE "inventory_purchases" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);
