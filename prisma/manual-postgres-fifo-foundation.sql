ALTER TABLE "restaurants"
  ADD COLUMN IF NOT EXISTS "fifoEnabled" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "restaurants"
  ADD COLUMN IF NOT EXISTS "fifoConfiguredAt" TIMESTAMP(3);

ALTER TABLE "restaurants"
  ADD COLUMN IF NOT EXISTS "fifoCutoverAt" TIMESTAMP(3);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'fifoEnabled'
  ) THEN
    EXECUTE '
      UPDATE "restaurants"
      SET "fifoEnabled" = TRUE,
          "fifoConfiguredAt" = COALESCE("updatedAt", CURRENT_TIMESTAMP)
      WHERE "ownerId" IN (
        SELECT "id"
        FROM "users"
        WHERE "fifoEnabled" = TRUE
      )
    ';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "inventory_batch_usage_ledgers" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "restaurantId" TEXT,
  "purchaseId" TEXT NOT NULL,
  "ingredientId" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "quantityConsumed" DOUBLE PRECISION NOT NULL,
  "unitCost" DOUBLE PRECISION NOT NULL,
  "totalCost" DOUBLE PRECISION NOT NULL,
  "reason" TEXT,
  "consumedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "inventory_batch_usage_ledgers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "inventory_batch_usage_ledgers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inventory_batch_usage_ledgers_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inventory_batch_usage_ledgers_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "inventory_purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inventory_batch_usage_ledgers_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "inventory_adjustment_logs" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "restaurantId" TEXT,
  "ingredientId" TEXT NOT NULL,
  "adjustmentType" TEXT NOT NULL,
  "quantityDelta" DOUBLE PRECISION NOT NULL,
  "itemQuantityBefore" DOUBLE PRECISION NOT NULL,
  "itemQuantityAfter" DOUBLE PRECISION NOT NULL,
  "batchId" TEXT,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "inventory_adjustment_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "inventory_adjustment_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inventory_adjustment_logs_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inventory_adjustment_logs_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "inventory_items"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "inventory_batch_usage_ledgers_restaurantId_ingredientId_consumedAt_idx"
  ON "inventory_batch_usage_ledgers"("restaurantId", "ingredientId", "consumedAt");

CREATE INDEX IF NOT EXISTS "inventory_batch_usage_ledgers_restaurantId_batchId_idx"
  ON "inventory_batch_usage_ledgers"("restaurantId", "batchId");

CREATE INDEX IF NOT EXISTS "inventory_batch_usage_ledgers_purchaseId_idx"
  ON "inventory_batch_usage_ledgers"("purchaseId");

CREATE INDEX IF NOT EXISTS "inventory_batch_usage_ledgers_sourceType_sourceId_idx"
  ON "inventory_batch_usage_ledgers"("sourceType", "sourceId");

CREATE INDEX IF NOT EXISTS "inventory_adjustment_logs_restaurantId_ingredientId_createdAt_idx"
  ON "inventory_adjustment_logs"("restaurantId", "ingredientId", "createdAt");

CREATE INDEX IF NOT EXISTS "inventory_adjustment_logs_restaurantId_batchId_idx"
  ON "inventory_adjustment_logs"("restaurantId", "batchId");