-- Shift (service session) + business-day attribution columns.
-- Everything is idempotent (IF NOT EXISTS + guarded constraints): a re-run must
-- never fail, because a failed migration blocks the entire site deploy.

CREATE TABLE IF NOT EXISTS "shifts" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "businessDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedByName" TEXT,
    "openedByStaffId" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedByName" TEXT,
    "closedByStaffId" TEXT,
    "sourceDeviceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "shifts_restaurantId_status_idx" ON "shifts"("restaurantId", "status");
CREATE INDEX IF NOT EXISTS "shifts_restaurantId_businessDate_idx" ON "shifts"("restaurantId", "businessDate");

ALTER TABLE "restaurant_orders" ADD COLUMN IF NOT EXISTS "shiftId" TEXT;
ALTER TABLE "restaurant_orders" ADD COLUMN IF NOT EXISTS "businessDate" TIMESTAMP(3);
ALTER TABLE "dish_sales" ADD COLUMN IF NOT EXISTS "businessDate" TIMESTAMP(3);
ALTER TABLE "journal_entries" ADD COLUMN IF NOT EXISTS "businessDate" TIMESTAMP(3);

DO $$ BEGIN
  ALTER TABLE "shifts" ADD CONSTRAINT "shifts_restaurantId_fkey"
    FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "restaurant_orders" ADD CONSTRAINT "restaurant_orders_shiftId_fkey"
    FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
