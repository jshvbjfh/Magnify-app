-- waste_logs was created in the baseline without deletedAt.
-- All other models got the column in later parity migrations, but waste_logs was missed.
ALTER TABLE "waste_logs" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

-- userId was required in the old schema but is no longer in the Prisma model.
-- Drop the NOT NULL constraint so inserts without userId succeed.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'waste_logs' AND column_name = 'userId' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE "waste_logs" ALTER COLUMN "userId" DROP NOT NULL;
  END IF;
END $$;
