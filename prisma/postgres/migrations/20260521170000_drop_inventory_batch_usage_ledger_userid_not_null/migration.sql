-- Migration: drop_inventory_batch_usage_ledger_userid_not_null
-- Purpose: paid-order FIFO consumption now records branch-scoped usage rows
-- without a legacy userId, so the hosted ledger must allow NULL userId.

DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'inventory_batch_usage_ledgers'
      AND column_name = 'userId'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "inventory_batch_usage_ledgers" ALTER COLUMN "userId" DROP NOT NULL;
  END IF;
END $$;
