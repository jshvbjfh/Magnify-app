-- Group operating-equipment movements into deliveries, the way stock entries
-- are grouped into batches: one delivery, one date, many lines typed under it.
--
-- Nullable, because a lone issue or correction belongs to no delivery, and
-- because every movement recorded before this column existed has none. Additive
-- with IF NOT EXISTS, so it is safe against the live database it will meet.
ALTER TABLE "operating_equipment_movements" ADD COLUMN IF NOT EXISTS "batchId" TEXT;

CREATE INDEX IF NOT EXISTS "operating_equipment_movements_restaurantId_branchId_batchId_idx" ON "operating_equipment_movements"("restaurantId", "branchId", "batchId");
