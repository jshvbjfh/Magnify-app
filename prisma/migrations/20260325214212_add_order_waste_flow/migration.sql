-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_restaurant_order_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "dishId" TEXT NOT NULL,
    "dishName" TEXT NOT NULL,
    "dishPrice" REAL NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "kitchenStatus" TEXT NOT NULL DEFAULT 'new',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "canceledById" TEXT,
    "canceledByName" TEXT,
    "cancellationApprovedByEmployeeId" TEXT,
    "cancellationApprovedByEmployeeName" TEXT,
    "cancelReason" TEXT,
    "wastedById" TEXT,
    "wastedByName" TEXT,
    "wasteReason" TEXT,
    "wasteAcknowledged" BOOLEAN NOT NULL DEFAULT false,
    "readyAt" DATETIME,
    "canceledAt" DATETIME,
    "wastedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "restaurant_order_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "restaurant_orders" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_restaurant_order_items" ("cancelReason", "canceledAt", "canceledById", "canceledByName", "cancellationApprovedByEmployeeId", "cancellationApprovedByEmployeeName", "createdAt", "dishId", "dishName", "dishPrice", "id", "kitchenStatus", "orderId", "qty", "readyAt", "status", "updatedAt") SELECT "cancelReason", "canceledAt", "canceledById", "canceledByName", "cancellationApprovedByEmployeeId", "cancellationApprovedByEmployeeName", "createdAt", "dishId", "dishName", "dishPrice", "id", "kitchenStatus", "orderId", "qty", "readyAt", "status", "updatedAt" FROM "restaurant_order_items";
DROP TABLE "restaurant_order_items";
ALTER TABLE "new_restaurant_order_items" RENAME TO "restaurant_order_items";
CREATE INDEX "restaurant_order_items_orderId_status_kitchenStatus_idx" ON "restaurant_order_items"("orderId", "status", "kitchenStatus");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
