-- Group operating-equipment movements into deliveries, the way stock entries
-- are grouped into batches: one delivery, one date, many lines typed under it.
-- (SQLite: dev + Electron local-first.)
--
-- Nullable, because a lone issue or correction belongs to no delivery, and
-- because every movement recorded before this column existed has none.
ALTER TABLE "operating_equipment_movements" ADD COLUMN "batchId" TEXT;

CREATE INDEX "operating_equipment_movements_restaurantId_branchId_batchId_idx" ON "operating_equipment_movements"("restaurantId", "branchId", "batchId");
