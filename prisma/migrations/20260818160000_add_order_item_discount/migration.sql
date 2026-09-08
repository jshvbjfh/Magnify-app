-- Per-line discount, 0-100, applied at the till against a supervisor PIN and
-- printed on the bill. Nullable with no default and no backfill: every existing
-- line stays NULL, which calculateLineNetAmount reads as "no discount", so not
-- one historical total, journal entry or DishSale changes value.
-- Plain ADD COLUMN: SQLite does not support the IF NOT EXISTS form on ALTER
-- TABLE, and rejects the whole statement as a syntax error. The migration
-- ledger is what stops this running twice, not the SQL.
ALTER TABLE "order_items" ADD COLUMN "discountPercent" REAL;
