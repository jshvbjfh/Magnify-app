-- CreateTable
CREATE TABLE "app_schema_state" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "databaseKind" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "syncProtocolVersion" INTEGER NOT NULL,
    "bootstrapVersion" INTEGER NOT NULL,
    "migrationState" TEXT NOT NULL,
    "lastMigratedAt" DATETIME,
    "lastBootstrapAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "branch_devices" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "restaurantId" TEXT,
    "appVersion" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "branch_devices_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "sync_outbox" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scopeId" TEXT NOT NULL,
    "restaurantId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "mutationId" TEXT NOT NULL,
    "sourceDeviceId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" DATETIME,
    "claimedAt" DATETIME,
    "syncedAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "sync_outbox_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "sync_cursors" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scopeId" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "restaurantId" TEXT,
    "lastPulledAt" DATETIME,
    "lastPushedAt" DATETIME,
    "lastMutationId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "sync_cursors_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "sync_conflict_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scopeId" TEXT NOT NULL,
    "restaurantId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "localMutationId" TEXT,
    "remoteMutationId" TEXT,
    "localPayload" TEXT,
    "remotePayload" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sync_conflict_logs_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_dish_sales" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "restaurantId" TEXT,
    "orderId" TEXT,
    "dishId" TEXT NOT NULL,
    "quantitySold" REAL NOT NULL,
    "saleDate" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paymentMethod" TEXT NOT NULL DEFAULT 'Cash',
    "totalSaleAmount" REAL NOT NULL,
    "calculatedFoodCost" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dish_sales_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "dish_sales_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "dish_sales_dishId_fkey" FOREIGN KEY ("dishId") REFERENCES "dishes" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_dish_sales" ("calculatedFoodCost", "createdAt", "dishId", "id", "orderId", "paymentMethod", "quantitySold", "restaurantId", "saleDate", "totalSaleAmount", "userId") SELECT "calculatedFoodCost", "createdAt", "dishId", "id", "orderId", "paymentMethod", "quantitySold", "restaurantId", "saleDate", "totalSaleAmount", "userId" FROM "dish_sales";
DROP TABLE "dish_sales";
ALTER TABLE "new_dish_sales" RENAME TO "dish_sales";
CREATE INDEX "dish_sales_restaurantId_idx" ON "dish_sales"("restaurantId");
CREATE INDEX "dish_sales_orderId_idx" ON "dish_sales"("orderId");
CREATE TABLE "new_dishes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "restaurantId" TEXT,
    "name" TEXT NOT NULL,
    "sellingPrice" REAL NOT NULL,
    "category" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "dishes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "dishes_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_dishes" ("category", "createdAt", "id", "isActive", "name", "sellingPrice", "updatedAt", "userId") SELECT "category", "createdAt", "id", "isActive", "name", "sellingPrice", "updatedAt", "userId" FROM "dishes";
DROP TABLE "dishes";
ALTER TABLE "new_dishes" RENAME TO "dishes";
CREATE INDEX "dishes_restaurantId_isActive_idx" ON "dishes"("restaurantId", "isActive");
CREATE UNIQUE INDEX "dishes_userId_restaurantId_name_key" ON "dishes"("userId", "restaurantId", "name");
CREATE TABLE "new_employees" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "restaurantId" TEXT,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "payType" TEXT NOT NULL,
    "payRate" REAL NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "canApproveOrderCancellation" BOOLEAN NOT NULL DEFAULT false,
    "cancellationPinHash" TEXT,
    "phone" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "employees_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "employees_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_employees" ("canApproveOrderCancellation", "cancellationPinHash", "createdAt", "id", "isActive", "name", "payRate", "payType", "phone", "role", "updatedAt", "userId") SELECT "canApproveOrderCancellation", "cancellationPinHash", "createdAt", "id", "isActive", "name", "payRate", "payType", "phone", "role", "updatedAt", "userId" FROM "employees";
DROP TABLE "employees";
ALTER TABLE "new_employees" RENAME TO "employees";
CREATE INDEX "employees_restaurantId_isActive_idx" ON "employees"("restaurantId", "isActive");
CREATE TABLE "new_inventory_adjustment_logs" (
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
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "inventory_adjustment_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "inventory_adjustment_logs_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "inventory_adjustment_logs_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "inventory_items" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_inventory_adjustment_logs" ("adjustmentType", "batchId", "createdAt", "id", "ingredientId", "itemQuantityAfter", "itemQuantityBefore", "quantityDelta", "reason", "restaurantId", "updatedAt", "userId") SELECT "adjustmentType", "batchId", "createdAt", "id", "ingredientId", "itemQuantityAfter", "itemQuantityBefore", "quantityDelta", "reason", "restaurantId", "updatedAt", "userId" FROM "inventory_adjustment_logs";
DROP TABLE "inventory_adjustment_logs";
ALTER TABLE "new_inventory_adjustment_logs" RENAME TO "inventory_adjustment_logs";
CREATE INDEX "inventory_adjustment_logs_restaurantId_ingredientId_createdAt_idx" ON "inventory_adjustment_logs"("restaurantId", "ingredientId", "createdAt");
CREATE INDEX "inventory_adjustment_logs_restaurantId_batchId_idx" ON "inventory_adjustment_logs"("restaurantId", "batchId");
CREATE TABLE "new_inventory_batch_usage_ledgers" (
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
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "inventory_batch_usage_ledgers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "inventory_batch_usage_ledgers_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "inventory_batch_usage_ledgers_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "inventory_purchases" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "inventory_batch_usage_ledgers_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "inventory_items" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_inventory_batch_usage_ledgers" ("batchId", "consumedAt", "createdAt", "id", "ingredientId", "purchaseId", "quantityConsumed", "reason", "restaurantId", "sourceId", "sourceType", "totalCost", "unitCost", "updatedAt", "userId") SELECT "batchId", "consumedAt", "createdAt", "id", "ingredientId", "purchaseId", "quantityConsumed", "reason", "restaurantId", "sourceId", "sourceType", "totalCost", "unitCost", "updatedAt", "userId" FROM "inventory_batch_usage_ledgers";
DROP TABLE "inventory_batch_usage_ledgers";
ALTER TABLE "new_inventory_batch_usage_ledgers" RENAME TO "inventory_batch_usage_ledgers";
CREATE INDEX "inventory_batch_usage_ledgers_restaurantId_ingredientId_consumedAt_idx" ON "inventory_batch_usage_ledgers"("restaurantId", "ingredientId", "consumedAt");
CREATE INDEX "inventory_batch_usage_ledgers_restaurantId_batchId_idx" ON "inventory_batch_usage_ledgers"("restaurantId", "batchId");
CREATE INDEX "inventory_batch_usage_ledgers_purchaseId_idx" ON "inventory_batch_usage_ledgers"("purchaseId");
CREATE INDEX "inventory_batch_usage_ledgers_sourceType_sourceId_idx" ON "inventory_batch_usage_ledgers"("sourceType", "sourceId");
CREATE TABLE "new_inventory_items" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "restaurantId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "unit" TEXT NOT NULL,
    "purchaseUnit" TEXT,
    "unitsPerPurchaseUnit" REAL,
    "unitCost" REAL,
    "unitPrice" REAL,
    "quantity" REAL NOT NULL DEFAULT 0,
    "category" TEXT,
    "inventoryType" TEXT NOT NULL DEFAULT 'resale',
    "reorderLevel" REAL NOT NULL DEFAULT 0,
    "shelfLifeDays" INTEGER,
    "lastRestockedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "inventory_items_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "inventory_items_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_inventory_items" ("category", "createdAt", "description", "id", "inventoryType", "lastRestockedAt", "name", "purchaseUnit", "quantity", "reorderLevel", "restaurantId", "shelfLifeDays", "unit", "unitCost", "unitPrice", "unitsPerPurchaseUnit", "updatedAt", "userId") SELECT "category", "createdAt", "description", "id", "inventoryType", "lastRestockedAt", "name", "purchaseUnit", "quantity", "reorderLevel", "restaurantId", "shelfLifeDays", "unit", "unitCost", "unitPrice", "unitsPerPurchaseUnit", "updatedAt", "userId" FROM "inventory_items";
DROP TABLE "inventory_items";
ALTER TABLE "new_inventory_items" RENAME TO "inventory_items";
CREATE INDEX "inventory_items_restaurantId_idx" ON "inventory_items"("restaurantId");
CREATE UNIQUE INDEX "inventory_items_userId_restaurantId_name_key" ON "inventory_items"("userId", "restaurantId", "name");
CREATE TABLE "new_inventory_purchases" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "restaurantId" TEXT,
    "batchId" TEXT,
    "journalPairId" TEXT,
    "ingredientId" TEXT NOT NULL,
    "supplier" TEXT,
    "purchaseQuantity" REAL,
    "purchaseUnit" TEXT,
    "unitsPerPurchaseUnit" REAL,
    "purchaseUnitCost" REAL,
    "quantityPurchased" REAL NOT NULL,
    "remainingQuantity" REAL NOT NULL,
    "unitCost" REAL NOT NULL,
    "totalCost" REAL NOT NULL,
    "purchasedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "inventory_purchases_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "inventory_purchases_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "inventory_purchases_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "inventory_items" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_inventory_purchases" ("batchId", "createdAt", "id", "ingredientId", "journalPairId", "purchaseQuantity", "purchaseUnit", "purchaseUnitCost", "purchasedAt", "quantityPurchased", "remainingQuantity", "restaurantId", "supplier", "totalCost", "unitCost", "unitsPerPurchaseUnit", "userId") SELECT "batchId", "createdAt", "id", "ingredientId", "journalPairId", "purchaseQuantity", "purchaseUnit", "purchaseUnitCost", "purchasedAt", "quantityPurchased", "remainingQuantity", "restaurantId", "supplier", "totalCost", "unitCost", "unitsPerPurchaseUnit", "userId" FROM "inventory_purchases";
DROP TABLE "inventory_purchases";
ALTER TABLE "new_inventory_purchases" RENAME TO "inventory_purchases";
CREATE INDEX "inventory_purchases_restaurantId_idx" ON "inventory_purchases"("restaurantId");
CREATE INDEX "inventory_purchases_restaurantId_batchId_idx" ON "inventory_purchases"("restaurantId", "batchId");
CREATE INDEX "inventory_purchases_journalPairId_idx" ON "inventory_purchases"("journalPairId");
CREATE TABLE "new_pricing_plans" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "duration" INTEGER NOT NULL,
    "price" REAL NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RWF',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "seedKey" TEXT,
    "systemManaged" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_pricing_plans" ("createdAt", "currency", "duration", "id", "isActive", "name", "price", "updatedAt") SELECT "createdAt", "currency", "duration", "id", "isActive", "name", "price", "updatedAt" FROM "pricing_plans";
DROP TABLE "pricing_plans";
ALTER TABLE "new_pricing_plans" RENAME TO "pricing_plans";
CREATE UNIQUE INDEX "pricing_plans_seedKey_key" ON "pricing_plans"("seedKey");
CREATE TABLE "new_transactions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "restaurantId" TEXT,
    "uploadId" TEXT,
    "accountId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "description" TEXT NOT NULL,
    "amount" REAL NOT NULL,
    "type" TEXT NOT NULL,
    "isManual" BOOLEAN NOT NULL DEFAULT false,
    "paymentMethod" TEXT NOT NULL DEFAULT 'Cash',
    "pairId" TEXT,
    "accountName" TEXT,
    "profitAmount" REAL,
    "costAmount" REAL,
    "sourceKind" TEXT NOT NULL DEFAULT 'manual',
    "authoritativeForRevenue" BOOLEAN NOT NULL DEFAULT true,
    "synced" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "transactions_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "transactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "transactions_uploadId_fkey" FOREIGN KEY ("uploadId") REFERENCES "uploads" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "transactions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "transactions_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_transactions" ("accountId", "accountName", "amount", "categoryId", "costAmount", "createdAt", "date", "description", "id", "isManual", "pairId", "paymentMethod", "profitAmount", "restaurantId", "synced", "type", "updatedAt", "uploadId", "userId") SELECT "accountId", "accountName", "amount", "categoryId", "costAmount", "createdAt", "date", "description", "id", "isManual", "pairId", "paymentMethod", "profitAmount", "restaurantId", "synced", "type", "updatedAt", "uploadId", "userId" FROM "transactions";
DROP TABLE "transactions";
ALTER TABLE "new_transactions" RENAME TO "transactions";
CREATE TABLE "new_waste_logs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "restaurantId" TEXT,
    "ingredientId" TEXT NOT NULL,
    "quantityWasted" REAL NOT NULL,
    "reason" TEXT NOT NULL,
    "date" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "calculatedCost" REAL NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "waste_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "waste_logs_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "waste_logs_ingredientId_fkey" FOREIGN KEY ("ingredientId") REFERENCES "inventory_items" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_waste_logs" ("calculatedCost", "createdAt", "date", "id", "ingredientId", "notes", "quantityWasted", "reason", "restaurantId", "userId") SELECT "calculatedCost", "createdAt", "date", "id", "ingredientId", "notes", "quantityWasted", "reason", "restaurantId", "userId" FROM "waste_logs";
DROP TABLE "waste_logs";
ALTER TABLE "new_waste_logs" RENAME TO "waste_logs";
CREATE INDEX "waste_logs_restaurantId_idx" ON "waste_logs"("restaurantId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "branch_devices_deviceId_key" ON "branch_devices"("deviceId");

-- CreateIndex
CREATE INDEX "branch_devices_restaurantId_lastSeenAt_idx" ON "branch_devices"("restaurantId", "lastSeenAt");

-- CreateIndex
CREATE INDEX "sync_outbox_scopeId_syncedAt_createdAt_idx" ON "sync_outbox"("scopeId", "syncedAt", "createdAt");

-- CreateIndex
CREATE INDEX "sync_outbox_scopeId_entityType_entityId_createdAt_idx" ON "sync_outbox"("scopeId", "entityType", "entityId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "sync_outbox_scopeId_mutationId_key" ON "sync_outbox"("scopeId", "mutationId");

-- CreateIndex
CREATE INDEX "sync_cursors_restaurantId_updatedAt_idx" ON "sync_cursors"("restaurantId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "sync_cursors_scopeId_target_key" ON "sync_cursors"("scopeId", "target");

-- CreateIndex
CREATE INDEX "sync_conflict_logs_scopeId_createdAt_idx" ON "sync_conflict_logs"("scopeId", "createdAt");

-- CreateIndex
CREATE INDEX "sync_conflict_logs_restaurantId_entityType_entityId_createdAt_idx" ON "sync_conflict_logs"("restaurantId", "entityType", "entityId", "createdAt");

