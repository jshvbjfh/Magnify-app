-- Add per-branch bill header (fallback: restaurant.billHeader)
ALTER TABLE branches ADD COLUMN IF NOT EXISTS "billHeader" TEXT;
