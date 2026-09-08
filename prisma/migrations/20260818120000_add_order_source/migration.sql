-- Which app took the order: 'tablet' (the Android APK) or 'desktop' (the
-- Windows till). Nullable, no default, no backfill: every existing order keeps
-- NULL, which the till reads as "not from a tablet". That is correct for
-- history and means switching the feature on never offers to reprint old
-- tickets. Guest QR orders also stay NULL — they arrive through the web route,
-- not a waiter app, and are already printed when a waiter confirms them.
-- Plain ADD COLUMN: SQLite does not support the IF NOT EXISTS form on ALTER
-- TABLE, and rejects the whole statement as a syntax error. The migration
-- ledger is what stops this running twice, not the SQL.
ALTER TABLE "restaurant_orders" ADD COLUMN "source" TEXT;
