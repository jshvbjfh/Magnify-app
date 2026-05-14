CREATE TABLE "restaurant_sync_states" (
    "restaurantId" TEXT NOT NULL PRIMARY KEY,
    "lastAttemptAt" DATETIME,
    "lastSuccessAt" DATETIME,
    "lastErrorAt" DATETIME,
    "lastErrorMessage" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedTransactions" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedSummaries" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "restaurant_sync_states_lastSuccessAt_idx" ON "restaurant_sync_states"("lastSuccessAt");
