CREATE TABLE "restaurant_sync_events" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "restaurantId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "syncedTransactions" INTEGER NOT NULL DEFAULT 0,
    "syncedSummaries" INTEGER NOT NULL DEFAULT 0,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "restaurant_sync_events_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "restaurant_sync_events_restaurantId_createdAt_idx" ON "restaurant_sync_events"("restaurantId", "createdAt");