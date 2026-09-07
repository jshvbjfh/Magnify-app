-- Record what was bought in the unit it was bought in: "2 bottles at 3000 each,
-- one bottle is 500 ml".
--
-- On the movement rather than the item, deliberately: a pack size changes
-- between deliveries. The same bleach arrives in a 500 ml bottle one week and a
-- 750 ml bottle the next, and pinning it to the item would silently re-value
-- every earlier delivery the day someone corrected it.
--
-- quantity and unitCost keep their meaning untouched — always the item's own
-- unit — so every existing row and every reader stays correct. All nullable and
-- additive, safe against the live database it will meet.
ALTER TABLE "operating_equipment_movements" ADD COLUMN IF NOT EXISTS "purchaseUnit" TEXT;
ALTER TABLE "operating_equipment_movements" ADD COLUMN IF NOT EXISTS "unitsPerPurchaseUnit" DOUBLE PRECISION;
ALTER TABLE "operating_equipment_movements" ADD COLUMN IF NOT EXISTS "purchaseQuantity" DOUBLE PRECISION;
ALTER TABLE "operating_equipment_movements" ADD COLUMN IF NOT EXISTS "purchaseUnitCost" DOUBLE PRECISION;
