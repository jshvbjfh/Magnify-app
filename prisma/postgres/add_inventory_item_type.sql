-- Add 'type' column to inventory_items to distinguish purchased vs in-house prepared (preps)
ALTER TABLE "inventory_items" ADD COLUMN IF NOT EXISTS "type" TEXT NOT NULL DEFAULT 'purchased';
