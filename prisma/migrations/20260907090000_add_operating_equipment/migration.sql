-- Operating equipment: the non-food supplies a venue buys to run itself —
-- soap, work slippers, mop sticks, bin liners.
-- (SQLite: dev + Electron local-first.)
--
-- A separate table rather than a third InventoryItem `type` on purpose. That
-- table feeds recipes, FIFO layers, food cost, stock reconciliation and the
-- owner dashboard's stock value, and most of those read every row for a
-- restaurant without filtering on type — so a bar of soap living there would
-- land in food cost unless ~27 call sites each remembered to exclude it.
--
-- Additive throughout: no existing table is touched except the restaurants
-- flag, which defaults off, so no venue sees any change until a manager asks.
ALTER TABLE "restaurants" ADD COLUMN "operatingEquipmentEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "operating_equipment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "restaurantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'piece',
    "quantity" REAL NOT NULL DEFAULT 0,
    "unitCost" REAL NOT NULL DEFAULT 0,
    "reorderLevel" REAL NOT NULL DEFAULT 0,
    "category" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "operating_equipment_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "operating_equipment_restaurantId_branchId_name_key" ON "operating_equipment"("restaurantId", "branchId", "name");
CREATE INDEX "operating_equipment_branchId_deletedAt_idx" ON "operating_equipment"("branchId", "deletedAt");

-- One ledger for every quantity change: stock in, stock out, stock-take
-- correction. `quantity` is SIGNED and the sign is the only source of truth for
-- direction — a magnitude plus a kind would make every reader re-derive it, and
-- one reader getting it backwards is a stock level that drifts in silence.
CREATE TABLE "operating_equipment_movements" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "equipmentId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "quantity" REAL NOT NULL,
    "unitCost" REAL NOT NULL DEFAULT 0,
    "totalCost" REAL NOT NULL DEFAULT 0,
    "supplier" TEXT,
    "note" TEXT,
    "recordedBy" TEXT,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "deletedAt" DATETIME,
    CONSTRAINT "operating_equipment_movements_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "operating_equipment" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "operating_equipment_movements_equipmentId_occurredAt_idx" ON "operating_equipment_movements"("equipmentId", "occurredAt");
CREATE INDEX "operating_equipment_movements_restaurantId_branchId_occurredAt_idx" ON "operating_equipment_movements"("restaurantId", "branchId", "occurredAt");
