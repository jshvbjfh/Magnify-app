DROP TABLE IF EXISTS "new_daily_summaries";
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_daily_summaries" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "restaurantId" TEXT,
    "date" DATETIME NOT NULL,
    "totalRevenue" REAL NOT NULL DEFAULT 0,
    "totalExpenses" REAL NOT NULL DEFAULT 0,
    "profitLoss" REAL NOT NULL DEFAULT 0,
    "lastUpdated" DATETIME NOT NULL,
    "synced" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "branchId" TEXT,
    CONSTRAINT "daily_summaries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "daily_summaries_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "new_daily_summaries" ("id","userId","restaurantId","date","totalRevenue","totalExpenses","profitLoss","lastUpdated","synced","createdAt")
SELECT "id","userId","restaurantId","date","totalRevenue","totalExpenses","profitLoss","lastUpdated","synced","createdAt" FROM "daily_summaries";

DROP TABLE "daily_summaries";
ALTER TABLE "new_daily_summaries" RENAME TO "daily_summaries";

CREATE UNIQUE INDEX "daily_summaries_userId_restaurantId_branchId_date_key"
    ON "daily_summaries"("userId","restaurantId","branchId","date");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
