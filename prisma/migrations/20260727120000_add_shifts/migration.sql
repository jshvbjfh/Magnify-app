-- Shift (service session) + business-day attribution columns (SQLite: dev + Electron local-first).

CREATE TABLE IF NOT EXISTS "shifts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "restaurantId" TEXT NOT NULL,
    "businessDate" DATETIME NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedByName" TEXT,
    "openedByStaffId" TEXT,
    "closedAt" DATETIME,
    "closedByName" TEXT,
    "closedByStaffId" TEXT,
    "sourceDeviceId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "shifts_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "shifts_restaurantId_status_idx" ON "shifts"("restaurantId", "status");
CREATE INDEX IF NOT EXISTS "shifts_restaurantId_businessDate_idx" ON "shifts"("restaurantId", "businessDate");

ALTER TABLE "restaurant_orders" ADD COLUMN "shiftId" TEXT;
ALTER TABLE "restaurant_orders" ADD COLUMN "businessDate" DATETIME;
ALTER TABLE "dish_sales" ADD COLUMN "businessDate" DATETIME;
ALTER TABLE "journal_entries" ADD COLUMN "businessDate" DATETIME;
