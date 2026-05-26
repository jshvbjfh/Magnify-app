-- userId was required in the old waste_logs schema but is no longer in the Prisma model.
-- Drop the NOT NULL constraint so inserts without userId succeed.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'waste_logs' AND column_name = 'userId' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "waste_logs" ALTER COLUMN "userId" DROP NOT NULL;
  END IF;
END $$;
