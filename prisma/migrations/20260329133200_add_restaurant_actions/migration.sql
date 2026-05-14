CREATE TABLE "restaurant_actions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "restaurantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "actionKey" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "orderId" TEXT,
    "orderItemId" TEXT,
    "tableId" TEXT,
    "tableName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "restaurant_actions_restaurantId_actionKey_key" ON "restaurant_actions"("restaurantId", "actionKey");
CREATE INDEX "restaurant_actions_restaurantId_actionType_createdAt_idx" ON "restaurant_actions"("restaurantId", "actionType", "createdAt");
