-- Record what was bought in the unit it was bought in: "2 bottles at 3000 each,
-- one bottle is 500 ml". (SQLite: dev + Electron local-first.)
--
-- On the movement rather than the item, deliberately: a pack size changes
-- between deliveries. The same bleach arrives in a 500 ml bottle one week and a
-- 750 ml bottle the next, and pinning it to the item would silently re-value
-- every earlier delivery the day someone corrected it.
--
-- quantity and unitCost keep their meaning untouched — always the item's own
-- unit — so every existing row and every reader stays correct.
ALTER TABLE "operating_equipment_movements" ADD COLUMN "purchaseUnit" TEXT;
ALTER TABLE "operating_equipment_movements" ADD COLUMN "unitsPerPurchaseUnit" REAL;
ALTER TABLE "operating_equipment_movements" ADD COLUMN "purchaseQuantity" REAL;
ALTER TABLE "operating_equipment_movements" ADD COLUMN "purchaseUnitCost" REAL;
