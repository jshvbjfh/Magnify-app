CREATE TABLE "restaurant_sync_batches" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "restaurantId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "syncedTransactions" INTEGER NOT NULL DEFAULT 0,
    "syncedSummaries" INTEGER NOT NULL DEFAULT 0,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "restaurant_sync_batches_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "restaurant_sync_batches_restaurantId_batchId_key" ON "restaurant_sync_batches"("restaurantId", "batchId");
CREATE INDEX "restaurant_sync_batches_restaurantId_receivedAt_idx" ON "restaurant_sync_batches"("restaurantId", "receivedAt");