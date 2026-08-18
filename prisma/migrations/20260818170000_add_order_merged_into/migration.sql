-- Joining orders: order X and order Y become one bill. The absorbed order keeps
-- its row -- status MERGED, items reassigned, mergedIntoId pointing at the
-- survivor -- so the join is auditable and an order number already quoted to a
-- guest still resolves to something. Nullable, no backfill: nothing existing
-- is a merged order.
ALTER TABLE "restaurant_orders" ADD COLUMN IF NOT EXISTS "mergedIntoId" TEXT;
