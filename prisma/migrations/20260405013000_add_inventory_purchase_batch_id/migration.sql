ALTER TABLE "inventory_purchases"
ADD COLUMN "batchId" TEXT;

CREATE INDEX "inventory_purchases_restaurantId_batchId_idx"
ON "inventory_purchases"("restaurantId", "batchId");