-- AlterTable
ALTER TABLE "pricing_plans" ALTER COLUMN "currency" SET DEFAULT 'RWF';

-- CreateTable
CREATE TABLE "restaurant_actions" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "actionKey" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "orderId" TEXT,
    "orderItemId" TEXT,
    "tableId" TEXT,
    "tableName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_sync_states" (
    "restaurantId" TEXT NOT NULL,
    "lastAttemptAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastErrorMessage" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedTransactions" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedSummaries" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_sync_states_pkey" PRIMARY KEY ("restaurantId")
);

-- CreateTable
CREATE TABLE "restaurant_sync_events" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "syncedTransactions" INTEGER NOT NULL DEFAULT 0,
    "syncedSummaries" INTEGER NOT NULL DEFAULT 0,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "restaurant_sync_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_sync_batches" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "syncedTransactions" INTEGER NOT NULL DEFAULT 0,
    "syncedSummaries" INTEGER NOT NULL DEFAULT 0,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurant_sync_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "restaurant_actions_restaurantId_actionType_createdAt_idx" ON "restaurant_actions"("restaurantId", "actionType", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_actions_restaurantId_actionKey_key" ON "restaurant_actions"("restaurantId", "actionKey");

-- CreateIndex
CREATE INDEX "restaurant_sync_events_restaurantId_createdAt_idx" ON "restaurant_sync_events"("restaurantId", "createdAt");

-- CreateIndex
CREATE INDEX "restaurant_sync_batches_restaurantId_receivedAt_idx" ON "restaurant_sync_batches"("restaurantId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "restaurant_sync_batches_restaurantId_batchId_key" ON "restaurant_sync_batches"("restaurantId", "batchId");

-- AddForeignKey
ALTER TABLE "restaurant_sync_states" ADD CONSTRAINT "restaurant_sync_states_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_sync_events" ADD CONSTRAINT "restaurant_sync_events_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restaurant_sync_batches" ADD CONSTRAINT "restaurant_sync_batches_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;


