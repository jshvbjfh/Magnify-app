-- Joining orders: order X and order Y become one bill. The absorbed order keeps
-- its row -- status MERGED, items reassigned, mergedIntoId pointing at the
-- survivor -- so the join is auditable and an order number already quoted to a
-- guest still resolves to something. Nullable, no backfill: nothing existing
-- is a merged order.
-- Plain ADD COLUMN: SQLite does not support the IF NOT EXISTS form on ALTER
-- TABLE, and rejects the whole statement as a syntax error. The migration
-- ledger is what stops this running twice, not the SQL.
ALTER TABLE "restaurant_orders" ADD COLUMN "mergedIntoId" TEXT;
