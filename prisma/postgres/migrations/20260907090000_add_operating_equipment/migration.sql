-- Operating equipment: the non-food supplies a venue buys to run itself —
-- soap, work slippers, mop sticks, bin liners.
--
-- A separate table rather than a third InventoryItem `type` on purpose. That
-- table feeds recipes, FIFO layers, food cost, stock reconciliation and the
-- owner dashboard's stock value, and most of those read every row for a
-- restaurant without filtering on type — so a bar of soap living there would
-- land in food cost unless ~27 call sites each remembered to exclude it.
--
-- Additive throughout, and IF NOT EXISTS everywhere: every environment shares
-- one Neon endpoint, so this runs against live data the moment any branch is
-- pushed. The flag defaults off, so nothing changes for any venue until a
-- manager switches it on.
ALTER TABLE "restaurants" ADD COLUMN IF NOT EXISTS "operatingEquipmentEnabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "operating_equipment" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'piece',
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unitCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reorderLevel" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "category" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "operating_equipment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "operating_equipment_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "operating_equipment_restaurantId_branchId_name_key" ON "operating_equipment"("restaurantId", "branchId", "name");
CREATE INDEX IF NOT EXISTS "operating_equipment_branchId_deletedAt_idx" ON "operating_equipment"("branchId", "deletedAt");

-- One ledger for every quantity change: stock in, stock out, stock-take
-- correction. `quantity` is SIGNED and the sign is the only source of truth for
-- direction — a magnitude plus a kind would make every reader re-derive it, and
-- one reader getting it backwards is a stock level that drifts in silence.
CREATE TABLE IF NOT EXISTS "operating_equipment_movements" (
    "id" TEXT NOT NULL,
    "equipmentId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unitCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "supplier" TEXT,
    "note" TEXT,
    "recordedBy" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "operating_equipment_movements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "operating_equipment_movements_equipmentId_fkey" FOREIGN KEY ("equipmentId") REFERENCES "operating_equipment"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "operating_equipment_movements_equipmentId_occurredAt_idx" ON "operating_equipment_movements"("equipmentId", "occurredAt");
CREATE INDEX IF NOT EXISTS "operating_equipment_movements_restaurantId_branchId_occurredA_idx" ON "operating_equipment_movements"("restaurantId", "branchId", "occurredAt");


