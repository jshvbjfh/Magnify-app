-- Per-line discount, 0-100, applied at the till against a supervisor PIN and
-- printed on the bill. Nullable with no default and no backfill: every existing
-- line stays NULL, which calculateLineNetAmount reads as "no discount", so not
-- one historical total, journal entry or DishSale changes value.
ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "discountPercent" DOUBLE PRECISION;
