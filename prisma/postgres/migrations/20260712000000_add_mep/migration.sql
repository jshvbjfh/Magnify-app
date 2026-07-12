ALTER TABLE "dishes" ADD COLUMN IF NOT EXISTS "preparedPortions" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "dishes" ADD COLUMN IF NOT EXISTS "preparedPortionCost" DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "mep_list_items" (
    "id"           TEXT         NOT NULL,
    "restaurantId" TEXT         NOT NULL,
    "branchId"     TEXT         NOT NULL,
    "targetType"   TEXT         NOT NULL,
    "targetId"     TEXT         NOT NULL,
    "addedBy"      TEXT,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt"    TIMESTAMP(3),
    CONSTRAINT "mep_list_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "prep_logs" (
    "id"                 TEXT             NOT NULL,
    "restaurantId"       TEXT             NOT NULL,
    "branchId"           TEXT             NOT NULL,
    "targetType"         TEXT             NOT NULL,
    "targetId"           TEXT             NOT NULL,
    "quantity"           DOUBLE PRECISION NOT NULL,
    "unit"               TEXT,
    "totalCost"          DOUBLE PRECISION NOT NULL DEFAULT 0,
    "costPerUnit"        DOUBLE PRECISION NOT NULL DEFAULT 0,
    "producedPurchaseId" TEXT,
    "madeBy"             TEXT,
    "madeAt"             TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clientLogId"        TEXT,
    "reversedAt"         TIMESTAMP(3),
    "createdAt"          TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "prep_logs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "mep_list_items_branchId_targetType_targetId_key" ON "mep_list_items"("branchId", "targetType", "targetId");
CREATE INDEX IF NOT EXISTS "mep_list_items_restaurantId_branchId_idx" ON "mep_list_items"("restaurantId", "branchId");
CREATE UNIQUE INDEX IF NOT EXISTS "prep_logs_clientLogId_key" ON "prep_logs"("clientLogId");
CREATE INDEX IF NOT EXISTS "prep_logs_restaurantId_branchId_madeAt_idx" ON "prep_logs"("restaurantId", "branchId", "madeAt");
