-- Migration: add_inventory_purchase_batch_id
-- Purpose: persist owner-visible inventory batch identifiers on purchase rows
-- so grouped inventory batches survive API writes, sync, and restore.

ALTER TABLE "inventory_purchases"
ADD COLUMN IF NOT EXISTS "batchId" TEXT;
