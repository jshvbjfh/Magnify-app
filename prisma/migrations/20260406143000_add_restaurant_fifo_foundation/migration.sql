ALTER TABLE "restaurants" ADD COLUMN "fifoEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "restaurants" ADD COLUMN "fifoConfiguredAt" DATETIME;
ALTER TABLE "restaurants" ADD COLUMN "fifoCutoverAt" DATETIME;

UPDATE "restaurants"
SET "fifoEnabled" = 1,
    "fifoConfiguredAt" = COALESCE("updatedAt", CURRENT_TIMESTAMP)
WHERE "ownerId" IN (
  SELECT "id"
  FROM "users"
  WHERE "fifoEnabled" = 1
);

CREATE TABLE "inventory_batch_usage_ledgers" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "restaurantId" TEXT,
  "purchaseId" TEXT NOT NULL,
  "ingredientId" TEXT NOT NULL,
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "quantityConsumed" REAL NOT NULL,
  "unitCost" REAL NOT NULL,
  "totalCost" REAL NOT NULL,
  "reason" TEXT,
  "consumedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inventory_batch_usage_ledgers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inventory_batch_usage_ledgers_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inventory_batch_usage_ledgers_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "inventory_purchases" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inventory_batch_usage_ledgers_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "inventory_items" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "inventory_adjustment_logs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "restaurantId" TEXT,
  "ingredientId" TEXT NOT NULL,
  "adjustmentType" TEXT NOT NULL,
  "quantityDelta" REAL NOT NULL,
  "itemQuantityBefore" REAL NOT NULL,
  "itemQuantityAfter" REAL NOT NULL,
  "batchId" TEXT,
  "reason" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inventory_adjustment_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inventory_adjustment_logs_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "inventory_adjustment_logs_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "inventory_items" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "inventory_batch_usage_ledgers_restaurantId_ingredientId_consumedAt_idx"
ON "inventory_batch_usage_ledgers"("restaurantId", "ingredientId", "consumedAt");

CREATE INDEX "inventory_batch_usage_ledgers_restaurantId_batchId_idx"
ON "inventory_batch_usage_ledgers"("restaurantId", "batchId");

CREATE INDEX "inventory_batch_usage_ledgers_purchaseId_idx"
ON "inventory_batch_usage_ledgers"("purchaseId");

CREATE INDEX "inventory_batch_usage_ledgers_sourceType_sourceId_idx"
ON "inventory_batch_usage_ledgers"("sourceType", "sourceId");

CREATE INDEX "inventory_adjustment_logs_restaurantId_ingredientId_createdAt_idx"
ON "inventory_adjustment_logs"("restaurantId", "ingredientId", "createdAt");

CREATE INDEX "inventory_adjustment_logs_restaurantId_batchId_idx"
ON "inventory_adjustment_logs"("restaurantId", "batchId");