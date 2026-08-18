-- Which app took the order: 'tablet' (the Android APK) or 'desktop' (the
-- Windows till). Nullable, no default, no backfill: every existing order keeps
-- NULL, which the till reads as "not from a tablet". That is correct for
-- history and means switching the feature on never offers to reprint old
-- tickets. Guest QR orders also stay NULL — they arrive through the web route,
-- not a waiter app, and are already printed when a waiter confirms them.
ALTER TABLE "restaurant_orders" ADD COLUMN IF NOT EXISTS "source" TEXT;
