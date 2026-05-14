-- AlterTable
ALTER TABLE "users" ADD COLUMN "subscriptionActivatedAt" DATETIME;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_restaurant_sync_states" (
    "restaurantId" TEXT NOT NULL PRIMARY KEY,
    "lastAttemptAt" DATETIME,
    "lastSuccessAt" DATETIME,
    "lastErrorAt" DATETIME,
    "lastErrorMessage" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedTransactions" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedSummaries" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "restaurant_sync_states_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_restaurant_sync_states" ("consecutiveFailures", "createdAt", "lastAttemptAt", "lastErrorAt", "lastErrorMessage", "lastSuccessAt", "lastSyncedSummaries", "lastSyncedTransactions", "restaurantId", "updatedAt") SELECT "consecutiveFailures", "createdAt", "lastAttemptAt", "lastErrorAt", "lastErrorMessage", "lastSuccessAt", "lastSyncedSummaries", "lastSyncedTransactions", "restaurantId", "updatedAt" FROM "restaurant_sync_states";
DROP TABLE "restaurant_sync_states";
ALTER TABLE "new_restaurant_sync_states" RENAME TO "restaurant_sync_states";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
