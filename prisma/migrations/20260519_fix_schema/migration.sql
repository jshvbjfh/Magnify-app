-- Add managerId, fifoEnabled, fifoConfiguredAt, syncRestaurantId to restaurants
ALTER TABLE "restaurants" ADD COLUMN "managerId" TEXT;
ALTER TABLE "restaurants" ADD COLUMN "fifoEnabled" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "restaurants" ADD COLUMN "fifoConfiguredAt" DATETIME;
ALTER TABLE "restaurants" ADD COLUMN "syncRestaurantId" TEXT;

CREATE INDEX "restaurants_managerId_idx" ON "restaurants"("managerId");
CREATE UNIQUE INDEX "restaurants_syncRestaurantId_key" ON "restaurants"("syncRestaurantId");

-- Fix sync_cursors: branchId must be nullable (migration said NOT NULL, schema says nullable)
PRAGMA foreign_keys = OFF;

CREATE TABLE "sync_cursors_new" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scopeId" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "restaurantId" TEXT,
    "branchId" TEXT,
    "lastPulledAt" DATETIME,
    "lastPushedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "sync_cursors_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "sync_cursors_new" SELECT * FROM "sync_cursors";
DROP TABLE "sync_cursors";
ALTER TABLE "sync_cursors_new" RENAME TO "sync_cursors";
CREATE INDEX "sync_cursors_branchId_idx" ON "sync_cursors"("branchId");
CREATE UNIQUE INDEX "sync_cursors_scopeId_target_key" ON "sync_cursors"("scopeId", "target");

-- Fix sync_outbox: branchId must be nullable
CREATE TABLE "sync_outbox_new" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scopeId" TEXT NOT NULL,
    "restaurantId" TEXT,
    "branchId" TEXT,
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
    CONSTRAINT "sync_outbox_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "sync_outbox_new" SELECT * FROM "sync_outbox";
DROP TABLE "sync_outbox";
ALTER TABLE "sync_outbox_new" RENAME TO "sync_outbox";
CREATE INDEX "sync_outbox_branchId_syncedAt_createdAt_idx" ON "sync_outbox"("branchId", "syncedAt", "createdAt");
CREATE UNIQUE INDEX "sync_outbox_scopeId_mutationId_key" ON "sync_outbox"("scopeId", "mutationId");

PRAGMA foreign_keys = ON;
