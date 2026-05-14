-- DropIndex
DROP INDEX "dishes_userId_name_key";

-- DropIndex
DROP INDEX "inventory_items_userId_name_key";

-- AlterTable
ALTER TABLE "dish_sales" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "dishes" ADD COLUMN     "restaurantId" TEXT;

-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "restaurantId" TEXT;

-- AlterTable
ALTER TABLE "inventory_adjustment_logs" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "inventory_batch_usage_ledgers" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "inventory_purchases" ADD COLUMN     "batchId" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "pricing_plans" ADD COLUMN     "seedKey" TEXT,
ADD COLUMN     "systemManaged" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "authoritativeForRevenue" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "sourceKind" TEXT NOT NULL DEFAULT 'manual';

-- AlterTable
ALTER TABLE "waste_logs" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "app_schema_state" (
    "key" TEXT NOT NULL,
    "databaseKind" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "syncProtocolVersion" INTEGER NOT NULL,
    "bootstrapVersion" INTEGER NOT NULL,
    "migrationState" TEXT NOT NULL,
    "lastMigratedAt" TIMESTAMP(3),
    "lastBootstrapAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_schema_state_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "branch_devices" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "restaurantId" TEXT,
    "appVersion" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "branch_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_outbox" (
    "id" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "restaurantId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "mutationId" TEXT NOT NULL,
    "sourceDeviceId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_cursors" (
    "id" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "restaurantId" TEXT,
    "lastPulledAt" TIMESTAMP(3),
    "lastPushedAt" TIMESTAMP(3),
    "lastMutationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sync_cursors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_conflict_logs" (
    "id" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "restaurantId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "localMutationId" TEXT,
    "remoteMutationId" TEXT,
    "localPayload" TEXT,
    "remotePayload" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sync_conflict_logs_pkey" PRIMARY KEY ("id")
);

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
CREATE INDEX "sync_conflict_logs_restaurantId_entityType_entityId_created_idx" ON "sync_conflict_logs"("restaurantId", "entityType", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "dishes_restaurantId_isActive_idx" ON "dishes"("restaurantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "dishes_userId_restaurantId_name_key" ON "dishes"("userId", "restaurantId", "name");

-- CreateIndex
CREATE INDEX "employees_restaurantId_isActive_idx" ON "employees"("restaurantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_items_userId_restaurantId_name_key" ON "inventory_items"("userId", "restaurantId", "name");

-- CreateIndex
CREATE INDEX "inventory_purchases_restaurantId_batchId_idx" ON "inventory_purchases"("restaurantId", "batchId");

-- CreateIndex
CREATE UNIQUE INDEX "pricing_plans_seedKey_key" ON "pricing_plans"("seedKey");

-- AddForeignKey
ALTER TABLE "branch_devices" ADD CONSTRAINT "branch_devices_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_outbox" ADD CONSTRAINT "sync_outbox_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_conflict_logs" ADD CONSTRAINT "sync_conflict_logs_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dishes" ADD CONSTRAINT "dishes_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dish_sales" ADD CONSTRAINT "dish_sales_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waste_logs" ADD CONSTRAINT "waste_logs_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_purchases" ADD CONSTRAINT "inventory_purchases_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employees" ADD CONSTRAINT "employees_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "inventory_adjustment_logs_restaurantId_ingredientId_createdAt_i" RENAME TO "inventory_adjustment_logs_restaurantId_ingredientId_created_idx";

-- RenameIndex
ALTER INDEX "inventory_batch_usage_ledgers_restaurantId_ingredientId_consume" RENAME TO "inventory_batch_usage_ledgers_restaurantId_ingredientId_con_idx";

