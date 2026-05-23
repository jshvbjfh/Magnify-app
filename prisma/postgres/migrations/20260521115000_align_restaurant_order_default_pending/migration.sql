-- Migration: align_restaurant_order_default_pending
-- Purpose: the active-order APIs treat pending restaurant orders as PENDING,
-- so the database default must match that domain state.

ALTER TABLE "restaurant_orders"
ALTER COLUMN "status" SET DEFAULT 'PENDING';

UPDATE "restaurant_orders"
SET "status" = 'PENDING'
WHERE "status" = 'OPEN';