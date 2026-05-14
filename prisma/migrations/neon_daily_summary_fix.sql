-- Drop the old unique constraint on daily_summaries (PostgreSQL)
-- and create a new one that includes branchId
DO $$
BEGIN
  -- Drop old unique constraint (may be named differently)
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'daily_summaries'::regclass
      AND contype = 'u'
      AND conname LIKE '%userId%restaurantId%date%'
  ) THEN
    ALTER TABLE daily_summaries DROP CONSTRAINT IF EXISTS "daily_summaries_userId_restaurantId_date_key";
  END IF;
END $$;

-- Remove duplicate rows before adding constraint (keep latest by id)
DELETE FROM daily_summaries a
USING daily_summaries b
WHERE a.id > b.id
  AND a."userId" = b."userId"
  AND a."restaurantId" IS NOT DISTINCT FROM b."restaurantId"
  AND a."branchId" IS NOT DISTINCT FROM b."branchId"
  AND a.date = b.date;

-- Add new constraint including branchId
ALTER TABLE daily_summaries
  DROP CONSTRAINT IF EXISTS "daily_summaries_userId_restaurantId_date_key";

CREATE UNIQUE INDEX IF NOT EXISTS "daily_summaries_userId_restaurantId_branchId_date_key"
  ON daily_summaries("userId", "restaurantId", "branchId", date);
